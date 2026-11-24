// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared by the mock and aws-runtime entries. Kept out of errors.ts so the
// browser entry, which re-exports SecretErrors, does not import core.

import { blocksError, brandBlocksError } from '@aws-cdk-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { SecretErrors } from './errors.js';

/**
 * Build the `SecretErrors.ValidationFailed` error for a schema rejection.
 *
 * The message, which reaches the RPC caller, is fixed and carries no part of
 * the input. Schema libraries often quote the received value in their issue
 * messages (zod: `… received 's3cr3t'`), and record or map schemas report the
 * input's own keys as the issue path, so both the first issue's message and its
 * `path` stay on the non-enumerable `cause`, with the full `issues` array, for
 * server-side logs.
 */
export function secretValidationFailed(issues: ReadonlyArray<StandardSchemaV1.Issue>): Error {
	const path = issues[0]?.path
		?.map((segment) => String(typeof segment === 'object' ? segment.key : segment))
		.join('.');
	const cause = Object.assign(new Error(issues[0]?.message ?? 'the secret value did not match the schema'), {
		issues,
		path,
	});
	const name = SecretErrors.ValidationFailed;
	const error = new Error(`${name}: The secret value did not match the schema`, { cause });
	error.name = name;
	return brandBlocksError(error);
}

/**
 * Secrets Manager's `SecretString` limit: 1 to 65,536 bytes. The API also caps
 * the length at 65,536 characters, but a UTF-8 byte count is never smaller than
 * the UTF-16 length, so the byte check covers both.
 *
 * The limit is in UTF-8 bytes, not characters, as observed against the real
 * `PutSecretValue` API (us-east-1, 2026-11-24): `'€'.repeat(21_846)`, which is
 * 21,846 characters and 65,538 bytes, fails with `LimitExceededException` ("The
 * secure secret must be between 1 and 65536 bytes in size"), and 65,536 ASCII
 * characters succeed. The quotas page's "number of characters" wording for
 * strings does not match the service. `test/secret.test.ts` in the
 * comprehensive test app pins this on deployed runs.
 */
export const MAX_SECRET_VALUE_BYTES = 65_536;

/** Secrets Manager's `VersionId` length bounds (any characters are accepted). */
export const MIN_VERSION_ID_LENGTH = 32;
export const MAX_VERSION_ID_LENGTH = 64;

/** A `SecretErrors.ValidationFailed` error with a fixed message that never quotes the value. */
function invalidValue(message: string): Error {
	return blocksError(SecretErrors.ValidationFailed, message);
}

/**
 * Serialize a `put()` value the way Secrets Manager stores it, rejecting what
 * `PutSecretValue` would reject. Shared by the mock and AWS `put()` and called
 * at the same point in both (after schema validation, before the write), so the
 * mock fails the same way the deployed block does instead of accepting a value
 * that AWS refuses with a raw service error.
 *
 * - Without a schema the value must be a string: an object would reach the SDK
 *   as a structure and fail with `SerializationException`.
 * - With a schema the value is stored as its JSON text, which must exist
 *   (`JSON.stringify(undefined)` has none, and a `bigint` or a circular object
 *   makes it throw a `TypeError` whose message can quote the value's keys).
 * - The stored text must be 1 to {@link MAX_SECRET_VALUE_BYTES} UTF-8 bytes.
 *
 * @returns The `SecretString` to store.
 * @throws {SecretErrors.ValidationFailed} When Secrets Manager would reject the value.
 */
export function serializeSecretValue(value: unknown, hasSchema: boolean): string {
	let serialized: string | undefined;
	if (hasSchema) {
		// A throw (bigint, circular reference) is treated like a missing JSON
		// text: the TypeError is unnamed for isBlocksError() and its message can
		// quote the value's own key names, so it must not reach the caller.
		try {
			serialized = JSON.stringify(value);
		} catch {
			serialized = undefined;
		}
		if (serialized === undefined) {
			throw invalidValue('The secret value has no JSON representation');
		}
	} else {
		if (typeof value !== 'string') {
			throw invalidValue('The secret value must be a string; configure a schema to store structured values');
		}
		serialized = value;
	}
	if (serialized.length === 0) {
		throw invalidValue('The secret value must not be empty');
	}
	const bytes = Buffer.byteLength(serialized, 'utf8');
	if (bytes > MAX_SECRET_VALUE_BYTES) {
		throw invalidValue(`The secret value is ${bytes} bytes, over the ${MAX_SECRET_VALUE_BYTES}-byte limit`);
	}
	return serialized;
}

/**
 * True when `versionId` is a string Secrets Manager accepts as a `VersionId`
 * (32 to 64 characters). `get()` returns `null` for any other handle, as it
 * does for a well-formed id that names no version: `GetSecretValue` would
 * otherwise fail with `ValidationException` on AWS while the mock finds nothing.
 * Also covers a handle without a string `versionId` arriving over RPC, which
 * the AWS entry would otherwise drop and read the current value instead.
 */
export function isWellFormedVersionId(versionId: unknown): versionId is string {
	return (
		typeof versionId === 'string' &&
		versionId.length >= MIN_VERSION_ID_LENGTH &&
		versionId.length <= MAX_VERSION_ID_LENGTH
	);
}

/**
 * True when a `get()` version selector asks for one specific version, which
 * cannot exist: anything other than `'current'`, `'previous'` or omitted that
 * is not a handle with a {@link isWellFormedVersionId well-formed} `versionId`.
 * Over RPC that also covers `null`, other strings and other objects. Both
 * entries call it first in `get()` and return `null` when it holds.
 */
export function namesNoVersion(version: unknown): boolean {
	if (version === undefined || version === 'current' || version === 'previous') return false;
	const versionId =
		typeof version === 'object' && version !== null ? (version as { versionId?: unknown }).versionId : undefined;
	return !isWellFormedVersionId(versionId);
}

/** Validate `value` against `schema`, throwing {@link secretValidationFailed} on rejection. */
export async function validateSchema<T>(schema: StandardSchemaV1<T>, value: unknown): Promise<T> {
	const result = schema['~standard'].validate(value);
	const resolved = result instanceof Promise ? await result : result;
	if (resolved.issues) {
		throw secretValidationFailed(resolved.issues);
	}
	return (resolved as { value: T }).value;
}
