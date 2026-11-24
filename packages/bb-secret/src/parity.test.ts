// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock↔AWS parity for `Secret.put()` values and `get()` version handles.
 *
 * Each case runs the same input through the local mock and through the AWS
 * runtime with `SecretsManagerClient.send` stubbed, and asserts both reach the
 * same outcome: the same named `SecretErrors` error (and message), or success.
 * The stub answers the way Secrets Manager does for these inputs (checked
 * against the real API): an empty or over-65,536-byte `SecretString` and a
 * `VersionId` outside 32-64 characters fail with `ValidationException`, and a
 * non-string `SecretString` fails with `SerializationException`. For success
 * the captured `PutSecretValueCommand` input is asserted too, and for a
 * rejection the test asserts nothing reached Secrets Manager.
 *
 * Following `bb-app-setting/src/parity.test.ts`.
 */
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, mock, test } from 'node:test';
import { Scope } from '@aws-cdk-blocks/core';
import { ResourceNotFoundException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Secret as AwsSecret } from './index.aws.js';
import { Secret as MockSecret, SecretErrors, type SecretVersion } from './index.mock.js';

const TEST_ARN = 'arn:aws:secretsmanager:us-east-1:111122223333:secret:parity-AbCdEf';
const BB_DATA = join(process.cwd(), '.cdk-blocks/local/data');
const LEGACY_BB_DATA = join(process.cwd(), '.bb-data');

beforeEach(() => {
	rmSync(BB_DATA, { recursive: true, force: true });
	rmSync(LEGACY_BB_DATA, { recursive: true, force: true });
});

let n = 0;
const uniqueId = () => `secret-parity-${n++}`;

/** Standard Schema that accepts any value as-is (stands in for zod & co.). */
const anySchema: StandardSchemaV1<unknown> = {
	'~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) },
};

/** An error shaped like the SDK's service exceptions for the given name. */
function serviceError(name: string, message: string): Error {
	return Object.assign(new Error(message), { name, $fault: 'client', $metadata: { httpStatusCode: 400 } });
}

/**
 * Stub `SecretsManagerClient.send` with Secrets Manager's behavior for the
 * inputs under test, recording every command input.
 */
function stubSecretsManager() {
	const commands: { type: string; input: Record<string, unknown> }[] = [];
	const m = mock.method(SecretsManagerClient.prototype, 'send', async (cmd: { input: Record<string, unknown> }) => {
		const type = cmd.constructor.name;
		commands.push({ type, input: cmd.input });
		if (type === 'PutSecretValueCommand') {
			const value = cmd.input.SecretString;
			if (typeof value !== 'string') {
				throw serviceError('SerializationException', 'Start of structure or map found where not expected.');
			}
			if (value.length < 1 || Buffer.byteLength(value, 'utf8') > 65_536) {
				throw serviceError('ValidationException', "Value at 'secretString' failed to satisfy constraint");
			}
			return { VersionId: '0123456789abcdef0123456789abcdef' };
		}
		if (type === 'GetSecretValueCommand') {
			const versionId = cmd.input.VersionId;
			if (typeof versionId === 'string' && (versionId.length < 32 || versionId.length > 64)) {
				throw serviceError('ValidationException', "Value at 'versionId' failed to satisfy constraint");
			}
			throw new ResourceNotFoundException({ message: "can't find the specified secret value", $metadata: {} });
		}
		throw new Error(`unexpected command ${type}`);
	});
	return { commands, restore: () => m.mock.restore() };
}

type Outcome = { ok: true; value?: unknown } | { ok: false; name: string; message: string };

async function outcomeOf(fn: () => Promise<unknown>): Promise<Outcome> {
	try {
		const value = await fn();
		return value === undefined ? { ok: true } : { ok: true, value };
	} catch (e) {
		const err = e as Error;
		return { ok: false, name: err.name, message: err.message };
	}
}

interface PutCase {
	label: string;
	schema?: boolean;
	value: unknown;
	/** `null` = success; otherwise the expected `SecretErrors` name. */
	error: string | null;
}

/** An object whose `self` key points back at it: `JSON.stringify` throws a TypeError naming `self`. */
const circular: Record<string, unknown> = {};
circular.self = circular;

const putCases: PutCase[] = [
	{ label: 'a non-empty string', value: 'sk_live_1', error: null },
	{ label: 'a single space', value: ' ', error: null },
	{ label: 'an empty string', value: '', error: SecretErrors.ValidationFailed },
	{ label: 'an object without a schema', value: { host: 'db' }, error: SecretErrors.ValidationFailed },
	{ label: 'a number without a schema', value: 5432, error: SecretErrors.ValidationFailed },
	{ label: 'an object with a schema', schema: true, value: { host: 'db' }, error: null },
	{ label: 'undefined with a schema', schema: true, value: undefined, error: SecretErrors.ValidationFailed },
	{ label: 'a bigint with a schema', schema: true, value: 10n, error: SecretErrors.ValidationFailed },
	{ label: 'a circular object with a schema', schema: true, value: circular, error: SecretErrors.ValidationFailed },
	{ label: 'exactly 65,536 bytes', value: 'a'.repeat(65_536), error: null },
	{ label: '65,537 bytes', value: 'a'.repeat(65_537), error: SecretErrors.ValidationFailed },
	{ label: 'a 70 KB value', value: 'a'.repeat(70 * 1024), error: SecretErrors.ValidationFailed },
	// 21,846 three-byte characters: under the character cap, over the byte cap.
	{ label: '65,538 bytes in 21,846 characters', value: '€'.repeat(21_846), error: SecretErrors.ValidationFailed },
	// JSON adds two quote bytes, so a 65,535-character string is 65,537 bytes stored.
	{
		label: 'a schema value whose JSON is 65,537 bytes',
		schema: true,
		value: 'a'.repeat(65_535),
		error: SecretErrors.ValidationFailed,
	},
];

describe('Secret.put() parity: mock vs AWS', () => {
	for (const c of putCases) {
		test(c.label, async () => {
			const options = { allowRuntimeWrite: true as const, ...(c.schema ? { schema: anySchema } : {}) };
			const mockSecret = new MockSecret<unknown>(new Scope('app'), uniqueId(), options);
			const mockOutcome = await outcomeOf(() => mockSecret.put(c.value));

			const { commands, restore } = stubSecretsManager();
			let awsOutcome: Outcome;
			try {
				const awsSecret = new AwsSecret<unknown>(new Scope('app'), uniqueId(), {
					...options,
					secret: AwsSecret.fromExisting(TEST_ARN),
				});
				awsOutcome = await outcomeOf(() => awsSecret.put(c.value));
			} finally {
				restore();
			}

			assert.deepStrictEqual(awsOutcome, mockOutcome, 'mock and AWS must reach the same outcome');
			if (c.error === null) {
				assert.deepStrictEqual(mockOutcome, { ok: true });
				assert.strictEqual(commands.length, 1);
				assert.strictEqual(commands[0].type, 'PutSecretValueCommand');
				assert.strictEqual(commands[0].input.SecretId, TEST_ARN);
				assert.strictEqual(commands[0].input.SecretString, c.schema ? JSON.stringify(c.value) : c.value);
			} else {
				assert.strictEqual(mockOutcome.ok, false);
				assert.strictEqual(!mockOutcome.ok && mockOutcome.name, c.error);
				assert.deepStrictEqual(commands, [], 'a rejected value must not reach Secrets Manager');
			}
		});
	}

	test('a value that JSON.stringify throws on is rejected without quoting its keys', async () => {
		const secret = new MockSecret<unknown>(new Scope('app'), uniqueId(), {
			allowRuntimeWrite: true,
			schema: anySchema,
		});
		const outcome = await outcomeOf(() => secret.put(circular));
		assert.deepStrictEqual(outcome, {
			ok: false,
			name: SecretErrors.ValidationFailed,
			message: `${SecretErrors.ValidationFailed}: The secret value has no JSON representation`,
		});
	});

	test('a rejected value leaves the stored value unchanged in the mock', async () => {
		const secret = new MockSecret(new Scope('app'), uniqueId(), { allowRuntimeWrite: true });
		await secret.put('kept');
		await assert.rejects(secret.put(''), { name: SecretErrors.ValidationFailed });
		assert.strictEqual(await secret.get(), 'kept');
	});
});

interface GetCase {
	label: string;
	version: SecretVersion;
	/** Whether the AWS entry is expected to call GetSecretValue. */
	callsAws: boolean;
}

const getCases: GetCase[] = [
	{ label: 'a short version id', version: { versionId: 'nope' }, callsAws: false },
	{ label: 'a 31-character version id', version: { versionId: 'a'.repeat(31) }, callsAws: false },
	{ label: 'a 65-character version id', version: { versionId: 'a'.repeat(65) }, callsAws: false },
	{ label: 'an unknown 32-character version id', version: { versionId: 'a'.repeat(32) }, callsAws: true },
	{
		label: 'an unknown UUID version id',
		version: { versionId: '00000000-0000-4000-8000-000000000000' },
		callsAws: true,
	},
	{ label: 'an unknown 64-character version id', version: { versionId: 'a'.repeat(64) }, callsAws: true },
];

describe('Secret.get() version handle parity: mock vs AWS', () => {
	for (const c of getCases) {
		test(`${c.label} returns null`, async () => {
			const mockSecret = new MockSecret(new Scope('app'), uniqueId(), { allowRuntimeWrite: true });
			await mockSecret.put('current');
			const mockOutcome = await outcomeOf(() => mockSecret.get({ version: c.version }));

			const { commands, restore } = stubSecretsManager();
			let awsOutcome: Outcome;
			try {
				const awsSecret = new AwsSecret(new Scope('app'), uniqueId(), {
					secret: AwsSecret.fromExisting(TEST_ARN),
				});
				awsOutcome = await outcomeOf(() => awsSecret.get({ version: c.version }));
			} finally {
				restore();
			}

			assert.deepStrictEqual(mockOutcome, { ok: true, value: null });
			assert.deepStrictEqual(awsOutcome, mockOutcome, 'mock and AWS must reach the same outcome');
			assert.strictEqual(commands.length, c.callsAws ? 1 : 0);
			if (c.callsAws) assert.strictEqual(commands[0].input.VersionId, c.version.versionId);
		});
	}

	// A handle without a string versionId can only arrive over RPC (the type
	// forbids it). The AWS entry used to drop the missing id and read the
	// current value; both entries now return null without a call.
	test('a handle without a string versionId returns null', async () => {
		const handle = JSON.parse('{"versionId":42}') as SecretVersion;
		const mockSecret = new MockSecret(new Scope('app'), uniqueId(), { allowRuntimeWrite: true });
		await mockSecret.put('current');
		assert.strictEqual(await mockSecret.get({ version: handle }), null);

		const { commands, restore } = stubSecretsManager();
		try {
			const awsSecret = new AwsSecret(new Scope('app'), uniqueId(), { secret: AwsSecret.fromExisting(TEST_ARN) });
			assert.strictEqual(await awsSecret.get({ version: handle }), null);
		} finally {
			restore();
		}
		assert.deepStrictEqual(commands, []);
	});
});
