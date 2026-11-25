// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { blocksError as prefixedBlocksError, brandBlocksError } from '@aws-cdk-blocks/core';
import { AppSettingErrors } from './errors.js';
import type { InternalAppSettingOptions } from './types.js';

// The index.aws.ts / index.mock.ts error paths use core's prefixing
// `blocksError` (message becomes `${name}: ${message}`). This helper stays
// local and deliberately leaves the message UNPREFIXED: these checks moved out
// of the CDK constructor, which threw a plain message, so keeping it unprefixed
// preserves the exact pre-refactor CDK synth error text.
//
// NOTE: do not re-prefix this one or route it through core's `blocksError` —
// adding the `${name}: ` prefix would change the CDK synth text that existing
// behavior pins.
function blocksError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return brandBlocksError(err);
}

/**
 * Validate the synchronous option combinations for an AppSetting.
 *
 * These checks depend only on which options are set together (not on the
 * supplied value against a schema, which can be async), so they must behave
 * identically in local mock and CDK. Async Standard Schema value validation
 * stays in each variant's own `put()` path.
 *
 * Throws {@link AppSettingErrors.ValidationFailed} on the first invalid
 * combination. `external` is package-internal (set only by `fromExisting`).
 */
export function validateAppSettingOptions<T>(
	id: string,
	options: InternalAppSettingOptions<T>,
): void {
	const external = options.external ?? false;

	if (options.secret && options.schema) {
		throw blocksError(
			AppSettingErrors.ValidationFailed,
			`AppSetting '${id}': 'secret' and 'schema' cannot be used together. ` +
			`Secrets are always plain strings. Remove the schema or the secret flag.`,
		);
	}

	if (options.schema && options.value === undefined) {
		throw blocksError(
			AppSettingErrors.ValidationFailed,
			`AppSetting '${id}': a schema is provided but no value. ` +
			`Provide a value that conforms to the schema so the SSM parameter is valid on first deploy.`,
		);
	}

	if (options.kmsKeyArn !== undefined) {
		if (!options.secret) {
			throw blocksError(
				AppSettingErrors.ValidationFailed,
				`AppSetting '${id}': 'kmsKeyArn' is only valid with 'secret: true'. ` +
				`Non-secret String parameters are not encrypted.`,
			);
		}
		if (options.kmsKeyArn.trim() === '') {
			throw blocksError(
				AppSettingErrors.ValidationFailed,
				`AppSetting '${id}': 'kmsKeyArn' must be a non-empty KMS key ARN. ` +
				`Omit it to use the default aws/ssm key.`,
			);
		}
	}

	if (options.secret && options.value !== undefined) {
		throw blocksError(
			AppSettingErrors.ValidationFailed,
			`AppSetting '${id}': secrets should not have a value in source code. ` +
			`Remove the value — a random secret will be generated on first deploy. ` +
			`Set the real value at runtime via AppSetting.put().`,
		);
	}

	if (external && options.value !== undefined) {
		throw blocksError(
			AppSettingErrors.ValidationFailed,
			`AppSetting '${id}': 'external' settings are owned elsewhere and must not have a value. ` +
			`Remove the value — the parameter is created and seeded outside this stack.`,
		);
	}

	if (external && !options.name) {
		throw blocksError(
			AppSettingErrors.ValidationFailed,
			`AppSetting '${id}': 'external' requires an explicit 'name' referencing the existing parameter.`,
		);
	}

	if (!options.secret && !external && options.value === undefined) {
		throw blocksError(
			AppSettingErrors.ValidationFailed,
			`AppSetting '${id}': non-secret settings require a value. ` +
			`Provide an initial value for the SSM parameter.`,
		);
	}
}

/**
 * Reject an empty string for a `secret: true` setting.
 *
 * `get()` throws {@link AppSettingErrors.ParameterNotFound} for an empty secret
 * on both paths, so `put('')` must not store one: it would succeed and leave
 * every later read failing. Shared by the mock and AWS `put()` paths and called
 * at the same point in both (after schema validation, before the size check).
 */
export function assertSecretValueNotEmpty(value: unknown, isSecret: boolean): void {
	if (isSecret && value === '') {
		throw prefixedBlocksError(AppSettingErrors.ValidationFailed, 'A secret value must not be empty');
	}
}

/** SSM standard-tier parameter value limit, in bytes. */
export const MAX_VALUE_BYTES = 4096;

/**
 * Serialize a value for storage, rejecting values with no JSON representation.
 *
 * `put()` stores `JSON.stringify(value)`. For `undefined`, a function or a
 * symbol that returns `undefined` (nothing to store), and for a bigint or a
 * circular object it throws a raw `TypeError`. Both cases become
 * {@link AppSettingErrors.ValidationFailed} here, with a fixed message so no
 * engine-specific text reaches the client. That text can quote the value's
 * key names (a circular `TypeError` names the closing property), so it is
 * kept only as the error's non-enumerable `cause`, for server-side logs.
 *
 * Shared by the mock and AWS `put()` paths and called at the same point in
 * both (after schema validation, before the size check), for secret and
 * non-secret settings alike.
 */
export function serializeValue(value: unknown): string {
	let serialized: string | undefined;
	let cause: unknown;
	try {
		serialized = JSON.stringify(value);
	} catch (e) {
		serialized = undefined;
		cause = e;
	}
	if (serialized === undefined) {
		const name = AppSettingErrors.ValidationFailed;
		// `new Error(message, { cause })` defines `cause` as non-enumerable, so
		// the RPC serializer does not send it to the client.
		const error = new Error(
			`${name}: Value of type ${typeof value} cannot be stored: it has no JSON representation`,
			cause === undefined ? undefined : { cause },
		);
		error.name = name;
		throw brandBlocksError(error);
	}
	return serialized;
}

/**
 * Reject a serialized value that exceeds the SSM standard-tier 4 KB limit.
 *
 * Shared by the mock and AWS `put()` paths and called at the same point in
 * both (after schema validation, before the write), so an oversized value
 * fails with the same {@link AppSettingErrors.ValidationFailed} locally and
 * deployed instead of reaching SSM. Unlike {@link validateAppSettingOptions},
 * this uses core's prefixing `blocksError` (message `${name}: ${message}`),
 * matching the other runtime `put()` errors.
 *
 * Secret settings are not size-checked here (unchanged behavior).
 */
export function assertValueWithinSizeLimit(serialized: string, isSecret: boolean): void {
	if (isSecret) return;
	const bytes = Buffer.byteLength(serialized, 'utf8');
	if (bytes > MAX_VALUE_BYTES) {
		throw prefixedBlocksError(
			AppSettingErrors.ValidationFailed,
			`Value size ${bytes} bytes exceeds the 4 KB (${MAX_VALUE_BYTES} bytes) limit`,
		);
	}
}
