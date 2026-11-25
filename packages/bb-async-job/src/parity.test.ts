// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock↔AWS parity for `AsyncJob.submit()` / `submitBatch()` input validation.
 *
 * Each case runs the same `delaySeconds` or payload through the local mock and
 * through the AWS runtime with the SQS client stubbed, and asserts both reach the same
 * outcome: the same named `AsyncJobErrors` error (and message), or success. For
 * success cases the captured SQS command input is asserted too, so a stub that
 * rejects every command cannot make a case pass vacuously; for rejected cases
 * the test asserts nothing reached SQS and the mock queued nothing.
 *
 * Following `bb-file-bucket/src/parity.test.ts`.
 */
import assert from 'node:assert';
import { describe, test } from 'node:test';
import { isWireSafeError, registerSdkIdentifiers, Scope } from '@aws-cdk-blocks/core';
import { AsyncJob as AwsAsyncJob } from './index.aws.js';
import { AsyncJobErrors, AsyncJob as MockAsyncJob } from './index.mock.js';

const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/000000000000/parity-queue';

let n = 0;
const uniqueId = () => `aj-parity-${Date.now()}-${n++}`;

type Outcome = { ok: true } | { ok: false; name: string; message: string; wireSafe: boolean };

async function outcomeOf(fn: () => Promise<unknown>): Promise<Outcome> {
	try {
		await fn();
		return { ok: true };
	} catch (e) {
		const err = e as Error;
		return { ok: false, name: err.name, message: err.message, wireSafe: isWireSafeError(err) };
	}
}

/** `pad` lets a case build a payload over the 256 KB limit. */
type Payload = { n: number; pad?: string };

interface SentInput {
	QueueUrl?: string;
	DelaySeconds?: number;
	MessageBody?: string;
	Entries?: Array<{ Id: string; DelaySeconds?: number; MessageBody?: string }>;
}

/** An AWS-runtime AsyncJob whose SQS client records every command and succeeds. */
function makeAwsJob<T = Payload>() {
	const job = new AwsAsyncJob<T>(new Scope('app'), uniqueId(), { handler: async () => {} });
	registerSdkIdentifiers(job.fullId, { queueUrl: QUEUE_URL });
	const inputs: SentInput[] = [];
	// Test plumbing: swap the private SDK client for a recording stub.
	(job as unknown as { _sqsClient: unknown })._sqsClient = {
		send: async (cmd: { input: SentInput }) => {
			inputs.push(cmd.input);
			if (cmd.input.Entries) {
				return {
					Successful: cmd.input.Entries.map((e) => ({ Id: e.Id, MessageId: `msg-${e.Id}` })),
					Failed: [],
				};
			}
			return { MessageId: 'msg-single' };
		},
	};
	return { job, inputs };
}

function makeMockJob<T = Payload>() {
	return new MockAsyncJob<T>(new Scope('app'), uniqueId(), { handler: async () => {} });
}

interface Case {
	label: string;
	/** `undefined` means the option is omitted. */
	delaySeconds: number | undefined;
	/** `null` = success; otherwise the expected `AsyncJobErrors` name. */
	error: string | null;
}

// SQS accepts an integer DelaySeconds from 0 to 900 on SendMessage and on each
// SendMessageBatch entry, and rejects anything else with InvalidParameterValue.
const cases: Case[] = [
	{ label: 'delaySeconds omitted', delaySeconds: undefined, error: null },
	{ label: 'delaySeconds 0', delaySeconds: 0, error: null },
	{ label: 'delaySeconds 900 (upper bound)', delaySeconds: 900, error: null },
	{ label: 'delaySeconds -1', delaySeconds: -1, error: AsyncJobErrors.ValidationFailed },
	{ label: 'delaySeconds 901', delaySeconds: 901, error: AsyncJobErrors.ValidationFailed },
	{ label: 'delaySeconds 3600', delaySeconds: 3600, error: AsyncJobErrors.ValidationFailed },
	{ label: 'delaySeconds 1.5 (not an integer)', delaySeconds: 1.5, error: AsyncJobErrors.ValidationFailed },
	{ label: 'delaySeconds NaN', delaySeconds: Number.NaN, error: AsyncJobErrors.ValidationFailed },
	{ label: 'delaySeconds Infinity', delaySeconds: Number.POSITIVE_INFINITY, error: AsyncJobErrors.ValidationFailed },
];

function assertSameOutcome(c: Case, mockOutcome: Outcome, awsOutcome: Outcome): void {
	assert.deepStrictEqual(awsOutcome, mockOutcome, 'mock and AWS outcomes differ');
	if (c.error === null) {
		assert.deepStrictEqual(mockOutcome, { ok: true });
	} else {
		assert.strictEqual(mockOutcome.ok, false);
		if (!mockOutcome.ok) {
			assert.strictEqual(mockOutcome.name, c.error);
			// Branded, so the name survives the RPC boundary instead of collapsing to a nameless 500.
			assert.strictEqual(mockOutcome.wireSafe, true);
		}
	}
}

describe('AsyncJob.submit() validates delaySeconds the same way on mock and AWS', () => {
	for (const c of cases) {
		test(c.label, async (t) => {
			// The mock schedules a delayed job with a real setTimeout (15 minutes for
			// the 900 case). Fake it so the file exits without --test-force-exit.
			t.mock.timers.enable({ apis: ['setTimeout'] });
			const options = c.delaySeconds === undefined ? undefined : { delaySeconds: c.delaySeconds };

			const mockJob = makeMockJob();
			const mockOutcome = await outcomeOf(() => mockJob.submit({ n: 1 }, options));

			const { job: awsJob, inputs } = makeAwsJob();
			const awsOutcome = await outcomeOf(() => awsJob.submit({ n: 1 }, options));

			assertSameOutcome(c, mockOutcome, awsOutcome);
			if (c.error === null) {
				assert.deepStrictEqual(
					inputs.map((i) => ({ QueueUrl: i.QueueUrl, DelaySeconds: i.DelaySeconds })),
					[{ QueueUrl: QUEUE_URL, DelaySeconds: c.delaySeconds ?? 0 }],
				);
				assert.strictEqual(mockJob._queue.totalSubmitted, 1);
			} else {
				assert.deepStrictEqual(inputs, [], 'nothing should reach SQS');
				assert.strictEqual(mockJob._queue.totalSubmitted, 0, 'the mock should queue nothing');
			}
		});
	}
});

describe('AsyncJob.submitBatch() validates delaySeconds the same way on mock and AWS', () => {
	for (const c of cases) {
		test(c.label, async (t) => {
			// See the submit() suite: keeps the mock's delay timers from holding the process open.
			t.mock.timers.enable({ apis: ['setTimeout'] });
			const options = c.delaySeconds === undefined ? undefined : { delaySeconds: c.delaySeconds };
			const payloads = [{ n: 1 }, { n: 2 }];

			const mockJob = makeMockJob();
			const mockOutcome = await outcomeOf(() => mockJob.submitBatch(payloads, options));

			const { job: awsJob, inputs } = makeAwsJob();
			const awsOutcome = await outcomeOf(() => awsJob.submitBatch(payloads, options));

			assertSameOutcome(c, mockOutcome, awsOutcome);
			if (c.error === null) {
				assert.deepStrictEqual(
					inputs.map((i) => ({ QueueUrl: i.QueueUrl, Entries: i.Entries?.map((e) => e.DelaySeconds) })),
					[{ QueueUrl: QUEUE_URL, Entries: [c.delaySeconds ?? 0, c.delaySeconds ?? 0] }],
				);
				assert.strictEqual(mockJob._queue.totalSubmitted, 2);
			} else {
				// Rejected as a whole with the validation error, not wrapped in
				// BatchSubmitFailedException after SQS refuses each entry.
				assert.deepStrictEqual(inputs, [], 'nothing should reach SQS');
				assert.strictEqual(mockJob._queue.totalSubmitted, 0, 'the mock should queue nothing');
			}
		});
	}
});

describe('AsyncJob.submitBatch() checks delaySeconds before the payloads on mock and AWS', () => {
	// Both entries check the batch delay before validating any payload, so a batch
	// with an invalid delay *and* an invalid payload reports the delay on both. The
	// mock's per-payload submit() would reject the delay anyway; this case is what
	// guards the batch-level check that sets the order.
	test('an invalid delay plus an oversized payload throws ValidationFailed, not PayloadTooLarge', async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const payloads: Payload[] = [{ n: 1 }, { n: 2, pad: 'x'.repeat(300 * 1024) }];

		const mockJob = makeMockJob();
		const mockOutcome = await outcomeOf(() => mockJob.submitBatch(payloads, { delaySeconds: 901 }));

		const { job: awsJob, inputs } = makeAwsJob();
		const awsOutcome = await outcomeOf(() => awsJob.submitBatch(payloads, { delaySeconds: 901 }));

		assertSameOutcome(
			{ label: 'precedence', delaySeconds: 901, error: AsyncJobErrors.ValidationFailed },
			mockOutcome,
			awsOutcome,
		);
		assert.ok(!mockOutcome.ok && mockOutcome.message.includes('delaySeconds'), 'the delay error should win');
		assert.deepStrictEqual(inputs, [], 'nothing should reach SQS');
		assert.strictEqual(mockJob._queue.totalSubmitted, 0, 'the mock should queue nothing');
	});
});

interface PayloadCase {
	label: string;
	payload: () => unknown;
	/** `null` = success (with the expected message body); otherwise the expected `AsyncJobErrors` name. */
	error: string | null;
	/** Expected SQS `MessageBody` on success. */
	body?: string;
}

/**
 * A cycle closed by a key named `apiKey`. The engine's error names the closing
 * property, so a message that quoted it would contain `apiKey`.
 */
function circular(): unknown {
	const o: { apiKey?: unknown } = {};
	o.apiKey = o;
	return o;
}

// The payload travels as a JSON message body. A value JSON cannot encode either
// makes JSON.stringify throw (bigint, a cycle) or return undefined (undefined, a
// function, a symbol); both must surface as ValidationFailed, not a raw TypeError.
// Nested undefined / function values are dropped by JSON.stringify and stay accepted.
const payloadCases: PayloadCase[] = [
	{ label: 'a plain object', payload: () => ({ n: 1 }), error: null, body: '{"n":1}' },
	{ label: 'null', payload: () => null, error: null, body: 'null' },
	{ label: 'a string', payload: () => 'hi', error: null, body: '"hi"' },
	{ label: 'a nested undefined (dropped)', payload: () => ({ a: 1, b: undefined }), error: null, body: '{"a":1}' },
	{ label: 'a nested function (dropped)', payload: () => ({ a: 1, f: () => 1 }), error: null, body: '{"a":1}' },
	{ label: 'undefined', payload: () => undefined, error: AsyncJobErrors.ValidationFailed },
	{ label: 'a function', payload: () => () => 1, error: AsyncJobErrors.ValidationFailed },
	{ label: 'a symbol', payload: () => Symbol('s'), error: AsyncJobErrors.ValidationFailed },
	{ label: 'a bigint', payload: () => 1n, error: AsyncJobErrors.ValidationFailed },
	{ label: 'a nested bigint', payload: () => ({ n: 1n }), error: AsyncJobErrors.ValidationFailed },
	{ label: 'a circular object', payload: circular, error: AsyncJobErrors.ValidationFailed },
	{
		label: 'a toJSON that returns undefined',
		payload: () => ({ toJSON: () => undefined }),
		error: AsyncJobErrors.ValidationFailed,
	},
	{
		label: 'a toJSON that throws',
		payload: () => ({
			toJSON() {
				throw new Error('token=s3cret');
			},
		}),
		error: AsyncJobErrors.ValidationFailed,
	},
];

function assertSamePayloadOutcome(mockOut: Outcome, awsOut: Outcome, expected: string | null): void {
	assert.deepStrictEqual(awsOut, mockOut, 'mock and AWS outcomes differ');
	if (expected === null) {
		assert.deepStrictEqual(mockOut, { ok: true });
	} else {
		assert.strictEqual(mockOut.ok, false);
		if (!mockOut.ok) {
			assert.strictEqual(mockOut.name, expected);
			// Branded, so the name survives the RPC boundary instead of collapsing to a nameless 500.
			assert.strictEqual(mockOut.wireSafe, true);
			// The branded message crosses the wire, so it must be fixed text: never the
			// engine's error (which names the key closing a cycle) or a toJSON()'s own text.
			assert.ok(!mockOut.message.includes('s3cret'), `message quotes toJSON(): ${mockOut.message}`);
			assert.ok(!mockOut.message.includes('apiKey'), `message quotes a key: ${mockOut.message}`);
		}
	}
}

describe('AsyncJob.submit() rejects a payload JSON cannot encode the same way on mock and AWS', () => {
	for (const c of payloadCases) {
		test(c.label, async () => {
			const mockJob = makeMockJob<unknown>();
			const { job: awsJob, inputs } = makeAwsJob<unknown>();
			const mockOutcome = await outcomeOf(() => mockJob.submit(c.payload()));
			const awsOutcome = await outcomeOf(() => awsJob.submit(c.payload()));
			assertSamePayloadOutcome(mockOutcome, awsOutcome, c.error);
			if (c.error === null) {
				assert.deepStrictEqual(
					inputs.map((i) => ({ QueueUrl: i.QueueUrl, MessageBody: i.MessageBody })),
					[{ QueueUrl: QUEUE_URL, MessageBody: c.body }],
				);
				assert.strictEqual(mockJob._queue.totalSubmitted, 1);
			} else {
				assert.deepStrictEqual(inputs, [], 'nothing should reach SQS');
				assert.strictEqual(mockJob._queue.totalSubmitted, 0, 'the mock should queue nothing');
			}
		});
	}
});

describe('AsyncJob.submitBatch() rejects a payload JSON cannot encode the same way on mock and AWS', () => {
	for (const c of payloadCases) {
		// One bad payload after a good one fails the whole call before anything is sent.
		test(`a good payload then ${c.label}`, async () => {
			const mockJob = makeMockJob<unknown>();
			const { job: awsJob, inputs } = makeAwsJob<unknown>();
			const mockOutcome = await outcomeOf(() => mockJob.submitBatch([{ ok: true }, c.payload()]));
			const awsOutcome = await outcomeOf(() => awsJob.submitBatch([{ ok: true }, c.payload()]));
			assertSamePayloadOutcome(mockOutcome, awsOutcome, c.error);
			if (c.error === null) {
				assert.deepStrictEqual(
					inputs.map((i) => i.Entries?.map((e) => e.MessageBody)),
					[['{"ok":true}', c.body]],
				);
				assert.strictEqual(mockJob._queue.totalSubmitted, 2);
			} else {
				assert.deepStrictEqual(inputs, [], 'nothing should reach SQS');
				assert.strictEqual(mockJob._queue.totalSubmitted, 0, 'the mock should queue nothing');
			}
		});
	}
});

describe('the mock handler gets the JSON round-trip of the payload, as the AWS handler does', () => {
	// The AWS handler receives JSON.parse(record.body), so the mock must not hand
	// over the live object: values JSON changes have to arrive changed locally too.
	test('a Date, a Map, NaN and a nested undefined arrive as JSON would carry them', async () => {
		let resolveSeen: (p: unknown) => void = () => {};
		const seen = new Promise<unknown>((r) => {
			resolveSeen = r;
		});
		const job = new MockAsyncJob<unknown>(new Scope('app'), uniqueId(), {
			handler: async (p) => {
				resolveSeen(p);
			},
		});
		const payload = { d: new Date(0), m: new Map([['k', 1]]), x: Number.NaN, u: undefined, n: { a: 1 } };
		await job.submit(payload);
		assert.deepStrictEqual(await seen, JSON.parse(JSON.stringify(payload)));
		assert.deepStrictEqual(await seen, { d: '1970-01-01T00:00:00.000Z', m: {}, x: null, n: { a: 1 } });
	});

	test('the handler gets a copy, so mutating the payload after submit() does not reach it', async () => {
		let resolveSeen: (p: unknown) => void = () => {};
		const seen = new Promise<unknown>((r) => {
			resolveSeen = r;
		});
		const job = new MockAsyncJob<{ n: number }>(new Scope('app'), uniqueId(), {
			handler: async (p) => {
				resolveSeen(p);
			},
		});
		const payload = { n: 1 };
		await job.submit(payload);
		payload.n = 2;
		assert.deepStrictEqual(await seen, { n: 1 });
	});
});
