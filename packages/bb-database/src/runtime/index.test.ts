// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { isBlocksError } from '@aws-cdk-blocks/core';
import type { TransactionHandle } from '../common/engine.js';
import { sql } from '../common/sql.js';
import { DatabaseErrors, serializationConflict } from '../errors.js';
import { RecordingEngine } from '../test-support/recording-engine.js';
import { conflictRetryDelayMs, DatabaseCore } from './index.js';

// The top of the range: `Math.random` returns less than 1.
const ALMOST_ONE = 1 - Number.EPSILON;

describe('conflictRetryDelayMs', () => {
	test('the ceiling doubles from the base with each retry and stops at the cap', () => {
		const ceilings = Array.from({ length: 9 }, (_, retry) => conflictRetryDelayMs(retry, () => ALMOST_ONE));
		assert.deepStrictEqual(ceilings, [50, 100, 200, 400, 800, 1600, 2000, 2000, 2000]);
		assert.strictEqual(
			conflictRetryDelayMs(5000, () => ALMOST_ONE),
			2000,
			'a large retry number stays at the cap',
		);
	});

	test('the wait is a whole number between 0 and the ceiling', () => {
		const cases: [retry: number, random: number, expected: number][] = [
			[0, 0, 0],
			[8, 0, 0],
			[0, 0.5, 25],
			[3, 0.5, 200],
			[7, 0.25, 500],
			[2, 0.37, 74],
		];
		for (const [retry, random, expected] of cases) {
			assert.strictEqual(
				conflictRetryDelayMs(retry, () => random),
				expected,
				`retry ${retry}, random ${random}`,
			);
		}
	});

	test('the default random source stays in the range', () => {
		for (let i = 0; i < 200; i++) {
			const delay = conflictRetryDelayMs(1);
			assert.ok(Number.isInteger(delay) && delay >= 0 && delay <= 100, `${delay} is in [0, 100]`);
		}
	});
});

/** Fails the first `conflicts` commits with `SerializationFailure`, as both engines report a conflict. */
class ConflictingEngine extends RecordingEngine {
	constructor(private conflicts: number) {
		super();
	}

	override async commitTransaction(handle: TransactionHandle): Promise<void> {
		await super.commitTransaction(handle);
		if (this.conflicts > 0) {
			this.conflicts--;
			throw serializationConflict(new Error('conflict'));
		}
	}
}

// The waits are recorded, not slept, so the suite asserts on what was asked for and never on the clock.
const retrying = (conflicts: number, onWait?: () => void) => {
	const engine = new ConflictingEngine(conflicts);
	const waits: number[] = [];
	const core = new DatabaseCore({
		engine: async () => engine,
		sleep: async (ms) => {
			waits.push(ms);
			onWait?.();
		},
		random: () => ALMOST_ONE,
	});
	const counter = { attempts: 0 };
	const run = async () => {
		counter.attempts++;
	};
	return { core, engine, waits, counter, run };
};

const isConflict = (e: unknown) => isBlocksError(e, DatabaseErrors.SerializationFailure);

describe('DatabaseCore.transaction() backs off between conflict retries', () => {
	test('the default is 8 retries: 8 conflicts commit on the ninth run, with a growing wait before each retry', async () => {
		const { core, waits, counter, run } = retrying(8);
		await core.transaction(run, { retryOnConflict: true });
		assert.strictEqual(counter.attempts, 9);
		assert.deepStrictEqual(waits, [50, 100, 200, 400, 800, 1600, 2000, 2000]);
	});

	test('a ninth conflict is past the default and throws SerializationFailure', async () => {
		const { core, waits, counter, run } = retrying(9);
		await assert.rejects(core.transaction(run, { retryOnConflict: true }), isConflict);
		assert.strictEqual(counter.attempts, 9, 'the first run and 8 retries');
		assert.strictEqual(waits.length, 8, 'no wait after the last attempt');
	});

	test('maxRetries bounds the retries: N conflicts commit when N is at most maxRetries, N + 1 throw', async () => {
		const within = retrying(3);
		await within.core.transaction(within.run, { retryOnConflict: true, maxRetries: 3 });
		assert.strictEqual(within.counter.attempts, 4);
		assert.deepStrictEqual(within.waits, [50, 100, 200]);

		const beyond = retrying(4);
		await assert.rejects(beyond.core.transaction(beyond.run, { retryOnConflict: true, maxRetries: 3 }), isConflict);
		assert.strictEqual(beyond.counter.attempts, 4);
		assert.deepStrictEqual(beyond.waits, [50, 100, 200]);

		const none = retrying(1);
		await assert.rejects(none.core.transaction(none.run, { retryOnConflict: true, maxRetries: 0 }), isConflict);
		assert.strictEqual(none.counter.attempts, 1);
		assert.deepStrictEqual(none.waits, []);
	});

	test('without retryOnConflict a conflict is thrown at once, with no wait', async () => {
		const { core, waits, counter, run } = retrying(2);
		await assert.rejects(core.transaction(run), isConflict);
		await assert.rejects(core.transaction(run, { maxRetries: 5 }), isConflict);
		assert.strictEqual(counter.attempts, 2, 'one run per call');
		assert.deepStrictEqual(waits, []);
	});

	test('maxRetries that is not a whole number of 0 or more is a configuration error, before any run', async () => {
		for (const maxRetries of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
			const { core, counter, run } = retrying(1);
			await assert.rejects(core.transaction(run, { retryOnConflict: true, maxRetries }), (e: unknown) =>
				isBlocksError(e, 'DatabaseConfigurationError'),
			);
			assert.strictEqual(counter.attempts, 0, `${maxRetries}`);
		}
	});

	test('an aborted signal stops the retries: no wait and no re-run', async () => {
		const { core, waits, counter, run } = retrying(2);
		await assert.rejects(core.transaction(run, { retryOnConflict: true, signal: AbortSignal.abort() }), isConflict);
		assert.strictEqual(counter.attempts, 1);
		assert.deepStrictEqual(waits, []);
	});

	test('a signal that aborts during the wait stops the retry that would follow', async () => {
		const controller = new AbortController();
		const { core, waits, counter, run } = retrying(2, () => controller.abort());
		await assert.rejects(core.transaction(run, { retryOnConflict: true, signal: controller.signal }), isConflict);
		assert.strictEqual(counter.attempts, 1, 'the run after the wait did not start');
		assert.deepStrictEqual(waits, [50]);
	});

	test('a signal that does not abort changes nothing', async () => {
		const { core, counter, run } = retrying(2);
		await core.transaction(run, { retryOnConflict: true, signal: new AbortController().signal });
		assert.strictEqual(counter.attempts, 3);
	});

	test('an error that is not a conflict is not retried', async () => {
		const { core, waits, counter } = retrying(0);
		await assert.rejects(
			core.transaction(
				async () => {
					counter.attempts++;
					throw new Error('driver text');
				},
				{ retryOnConflict: true },
			),
			(e: unknown) => isBlocksError(e, DatabaseErrors.TransactionFailed),
		);
		assert.strictEqual(counter.attempts, 1);
		assert.deepStrictEqual(waits, []);
	});

	test('a single auto-commit statement keeps its own fixed wait', async () => {
		const { core, engine, waits } = retrying(0);
		engine.failOn.set('SELECT 1', serializationConflict(new Error('conflict')));
		await core.query(sql`SELECT 1`);
		assert.deepStrictEqual(
			engine.calls.map((c) => c.method),
			['query', 'query'],
			'the statement was retried',
		);
		assert.deepStrictEqual(waits, [50], 'the first entry of the auto-commit table, not the transaction() wait');
	});
});
