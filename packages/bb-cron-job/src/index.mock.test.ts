// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { isBlocksError } from '@aws-cdk-blocks/core';
import { CronJob, CronJobErrors } from './index.mock.js';

const fakeScope = {
	_id: 'test',
	_children: [] as any[],
	addChild(c: any) {
		this._children.push(c);
	},
	get fullId() {
		return 'test';
	},
} as any;

describe('CronJob mock – schedules far in the future', () => {
	beforeEach(() => {
		mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-03-01T00:00:00Z') });
	});

	afterEach(() => {
		mock.timers.reset();
	});

	test('a leap-day schedule fires on the next leap day, not an hour later', () => {
		const fired: string[] = [];
		new CronJob(fakeScope, 'leap-day', {
			schedule: 'cron(0 0 29 2 ? *)',
			handler: async (event) => {
				fired.push(event.scheduledTime);
			},
		});

		mock.timers.tick(2 * 3_600_000);
		assert.deepStrictEqual(fired, []);

		const until = new Date('2028-03-01T00:00:00Z').getTime();
		while (Date.now() < until) {
			mock.timers.tick(Math.min(3_600_000, until - Date.now()));
		}
		assert.deepStrictEqual(fired, ['2028-02-29T00:00:00Z']);
	});

	test('a yearly schedule more than 24.8 days away waits for its date', () => {
		const fired: string[] = [];
		new CronJob(fakeScope, 'yearly', {
			schedule: 'cron(0 0 1 1 ? *)',
			handler: async (event) => {
				fired.push(event.scheduledTime);
			},
		});

		const until = new Date('2027-01-02T00:00:00Z').getTime();
		while (Date.now() < until) {
			mock.timers.tick(Math.min(3_600_000, until - Date.now()));
		}
		assert.deepStrictEqual(fired, ['2027-01-01T00:00:00Z']);
	});
});

describe('CronJob mock – rate schedules longer than a timer allows', () => {
	afterEach(() => {
		mock.timers.reset();
		mock.restoreAll();
	});

	test('rate(30 days) never schedules a timer delay Node would clamp to 1 ms', () => {
		mock.method(console, 'log', () => {});
		const setTimeoutSpy = mock.method(globalThis, 'setTimeout');
		const setIntervalSpy = mock.method(globalThis, 'setInterval');
		new CronJob(fakeScope, 'monthly-rate', {
			schedule: 'rate(30 days)',
			handler: async () => {},
		});

		// Node treats a timer delay above 2^31-1 ms as 1 ms, so such a timer would fire every millisecond.
		const delays = [...setTimeoutSpy.mock.calls, ...setIntervalSpy.mock.calls].map((c) => Number(c.arguments[1]));
		assert.notDeepStrictEqual(delays, []);
		assert.ok(
			delays.every((d) => d <= 2_147_483_647),
			`timer delays: ${delays.join(', ')}`,
		);
	});

	test('rate(30 days) fires every 30 days', () => {
		mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-03-01T00:00:00Z') });
		mock.method(console, 'log', () => {});
		const fired: string[] = [];
		new CronJob(fakeScope, 'monthly-rate', {
			schedule: 'rate(30 days)',
			handler: async (event) => {
				fired.push(event.scheduledTime);
			},
		});

		const until = new Date('2026-05-01T00:00:00Z').getTime();
		while (Date.now() < until) {
			mock.timers.tick(Math.min(86_400_000, until - Date.now()));
		}
		assert.deepStrictEqual(fired, ['2026-03-31T00:00:00Z', '2026-04-30T00:00:00Z']);
	});

	test('rate(30 days) runs once after the clock jumps past several intervals, then resumes its cadence', () => {
		mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-03-01T00:00:00Z') });
		mock.method(console, 'log', () => {});
		const fired: string[] = [];
		new CronJob(fakeScope, 'monthly-rate-after-sleep', {
			schedule: 'rate(30 days)',
			handler: async (event) => {
				fired.push(event.scheduledTime);
			},
		});

		const beforeSleep = new Date('2026-03-30T00:00:00Z').getTime();
		while (Date.now() < beforeSleep) {
			mock.timers.tick(Math.min(86_400_000, beforeSleep - Date.now()));
		}
		assert.deepStrictEqual(fired, []);

		// One jump of 75 days passes the slots due on 03-31, 04-30 and 05-30. The one run reports
		// the latest of them, 05-30, as its scheduledTime.
		mock.timers.tick(75 * 86_400_000);
		assert.deepStrictEqual(fired, ['2026-05-30T00:00:00Z']);

		const until = new Date('2026-06-30T00:00:00Z').getTime();
		while (Date.now() < until) {
			mock.timers.tick(Math.min(86_400_000, until - Date.now()));
		}
		assert.deepStrictEqual(fired, ['2026-05-30T00:00:00Z', '2026-06-29T00:00:00Z']);
	});
});

describe('CronJob mock – scheduledTime is the schedule slot', () => {
	beforeEach(() => {
		mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: new Date('2026-03-01T00:00:00Z') });
		mock.method(console, 'log', () => {});
	});

	afterEach(() => {
		mock.timers.reset();
		mock.restoreAll();
	});

	test('a cron schedule reports the slot, not the moment a late timer fired', () => {
		const fired: string[] = [];
		new CronJob(fakeScope, 'every-ten', {
			schedule: 'cron(0/10 * * * ? *)',
			handler: async (event) => {
				fired.push(event.scheduledTime);
			},
		});

		// The timer runs 1.5 s after the 00:10 slot, more than the milliseconds the format
		// drops, so only an event that carries the slot passes.
		mock.timers.tick(10 * 60_000 + 1_500);
		assert.deepStrictEqual(fired, ['2026-03-01T00:10:00Z']);
	});

	test('a rate schedule reports each slot, not the moment a late timer fired', () => {
		const fired: string[] = [];
		new CronJob(fakeScope, 'every-five', {
			schedule: 'rate(5 minutes)',
			handler: async (event) => {
				fired.push(event.scheduledTime);
			},
		});

		// As above, the first timer runs 1.5 s late so the test checks the slot, not the format.
		mock.timers.tick(5 * 60_000 + 1_500);
		mock.timers.tick(5 * 60_000);
		assert.deepStrictEqual(fired, ['2026-03-01T00:05:00Z', '2026-03-01T00:10:00Z']);
	});

	test('a rate schedule reports the latest due slot after the machine wakes from sleep', () => {
		// During a suspend the wall clock moves on but setInterval's monotonic clock does not. The
		// mocked timers stand in for the monotonic clock and a stubbed Date.now for the wall clock.
		// (mock.timers.setTime would leave the interval's due times behind and replay every one.)
		mock.timers.reset();
		mock.timers.enable({ apis: ['setInterval'] });
		let wallMs = Date.parse('2026-03-01T00:00:00Z');
		mock.method(Date, 'now', () => wallMs);
		const fired: string[] = [];
		new CronJob(fakeScope, 'every-five-after-sleep', {
			schedule: 'rate(5 minutes)',
			handler: async (event) => {
				fired.push(event.scheduledTime);
			},
		});

		wallMs += 5 * 60_000;
		mock.timers.tick(5 * 60_000);
		// One hour asleep: the wall clock gains an hour more than the interval saw.
		wallMs += 3_600_000 + 5 * 60_000;
		mock.timers.tick(5 * 60_000);
		wallMs += 5 * 60_000;
		mock.timers.tick(5 * 60_000);
		assert.deepStrictEqual(fired, ['2026-03-01T00:05:00Z', '2026-03-01T01:10:00Z', '2026-03-01T01:15:00Z']);
	});
});

describe('CronJob mock – schedules that cannot match', () => {
	beforeEach(() => {
		mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-03-01T00:00:00Z') });
	});

	afterEach(() => {
		mock.timers.reset();
		mock.restoreAll();
	});

	test('a schedule with no real date is rejected, as at synth', () => {
		mock.method(console, 'log', () => {});
		assert.throws(
			() =>
				new CronJob(fakeScope, 'feb-30', {
					schedule: 'cron(0 0 30 2 ? *)',
					handler: async () => {},
				}),
			(e: unknown) => isBlocksError(e, CronJobErrors.InvalidSchedule),
		);
	});

	test('a leap-day schedule only logs that it is checking again later', () => {
		const warn = mock.method(console, 'warn', () => {});
		mock.method(console, 'log', () => {});
		new CronJob(fakeScope, 'leap-day', {
			schedule: 'cron(0 0 29 2 ? *)',
			handler: async () => {},
		});

		assert.strictEqual(warn.mock.callCount(), 0);
	});
});
