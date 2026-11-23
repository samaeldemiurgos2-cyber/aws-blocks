// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock↔AWS parity for `CronJob` constructor validation.
 *
 * Each case constructs a CronJob from the local mock and from the AWS runtime
 * entry with the same `schedule` and `timezone`, and asserts both reach the same
 * outcome: the same named `CronJobErrors` error (and message), or success. The
 * synth gate runs the same `validateSchedule`/`validateTimezone`, so a schedule
 * that deploys also constructs in Lambda.
 *
 * Following `bb-file-bucket/src/parity.test.ts`.
 */
import assert from 'node:assert';
import { describe, test } from 'node:test';
import { isBlocksError, Scope } from '@aws-cdk-blocks/core';
import { CronJob as AwsCronJob } from './index.aws.js';
import { CronJobErrors, CronJob as MockCronJob } from './index.mock.js';

let n = 0;
const uniqueId = () => `cj-parity-${Date.now()}-${n++}`;

type Outcome = { ok: true } | { ok: false; name: string; message: string };

function outcome(build: () => unknown): Outcome {
	try {
		build();
		return { ok: true };
	} catch (e) {
		const err = e as Error;
		return { ok: false, name: err.name, message: err.message };
	}
}

function construct(Ctor: typeof MockCronJob | typeof AwsCronJob, schedule: string, timezone?: string): Outcome {
	const scope = new Scope(uniqueId());
	// `enabled: false` keeps the mock from starting timers.
	return outcome(() => new Ctor(scope, 'job', { schedule, timezone, enabled: false, handler: async () => {} }));
}

const valid: [string, string?][] = [
	['rate(1 minute)'],
	['rate(5 minutes)'],
	['cron(0 9 * * ? *)'],
	['cron(30 9 ? * MON-FRI *)'],
	['cron(0 0 29 2 ? *)'], // leap day exists
	['cron(0 0 31 1,4 ? *)'], // Jan 31 exists, even though Apr 31 does not
	['cron(0 9 * * ? *)', 'America/New_York'],
];

const invalid: [string, string | undefined, string][] = [
	['', undefined, CronJobErrors.InvalidSchedule],
	['rate(0 minutes)', undefined, CronJobErrors.InvalidSchedule],
	['rate(10 seconds)', undefined, CronJobErrors.InvalidSchedule],
	['rate(1 minutes)', undefined, CronJobErrors.InvalidSchedule],
	['every 5 minutes', undefined, CronJobErrors.InvalidSchedule],
	['cron(0 9 * * *)', undefined, CronJobErrors.InvalidSchedule],
	['cron(0 12 * * MON *)', undefined, CronJobErrors.InvalidSchedule], // both day fields set
	['cron(0 0 ? * ? *)', undefined, CronJobErrors.InvalidSchedule], // neither day field set
	['cron(0 0 30 2 ? *)', undefined, CronJobErrors.InvalidSchedule], // Feb 30
	['cron(0 0 31 4,6,9,11 ? *)', undefined, CronJobErrors.InvalidSchedule], // 31st of 30-day months
	['rate(5 minutes)', '', CronJobErrors.InvalidTimezone],
	['rate(5 minutes)', '   ', CronJobErrors.InvalidTimezone],
	['rate(5 minutes)', 'Not/AZone', CronJobErrors.InvalidTimezone],
	// Both inputs wrong: every entry checks the schedule first.
	['cron(0 12 * * MON *)', 'Not/AZone', CronJobErrors.InvalidSchedule],
	['rate(10 seconds)', '', CronJobErrors.InvalidSchedule],
];

describe('CronJob constructor: mock and AWS runtime agree', () => {
	for (const [schedule, timezone] of valid) {
		test(`accepts ${JSON.stringify(schedule)} tz=${JSON.stringify(timezone)}`, () => {
			assert.deepStrictEqual(construct(MockCronJob, schedule, timezone), { ok: true });
			assert.deepStrictEqual(construct(AwsCronJob, schedule, timezone), { ok: true });
		});
	}

	for (const [schedule, timezone, name] of invalid) {
		test(`rejects ${JSON.stringify(schedule)} tz=${JSON.stringify(timezone)} with ${name}`, () => {
			const mockOutcome = construct(MockCronJob, schedule, timezone);
			const awsOutcome = construct(AwsCronJob, schedule, timezone);
			assert.strictEqual(mockOutcome.ok, false);
			assert.strictEqual(!mockOutcome.ok && mockOutcome.name, name);
			assert.deepStrictEqual(awsOutcome, mockOutcome);
		});
	}

	test('rejected errors are branded so their name crosses the wire', () => {
		assert.throws(
			() =>
				new AwsCronJob(new Scope(uniqueId()), 'job', {
					schedule: 'cron(0 0 ? * ? *)',
					handler: async () => {},
				}),
			(e: unknown) => isBlocksError(e, CronJobErrors.InvalidSchedule),
		);
	});
});
