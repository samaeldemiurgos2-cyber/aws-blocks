// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, registerSdkIdentifiers } from '@aws-cdk-blocks/core';
import type { ScopeParent } from '@aws-cdk-blocks/core';
import type {
	CronJobEvent,
	CronJobOptions,
} from './types.js';
import { Logger } from '@aws-cdk-blocks/bb-logger';
import type { ChildLogger } from '@aws-cdk-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';
import { assertNotMockInDeployedEnv } from '@aws-cdk-blocks/core/bb-utils';

// Fail closed if this mock entry loads in a deployed env — see assertNotMockInDeployedEnv.
assertNotMockInDeployedEnv('bb-cron-job');

export { CronJobErrors } from './errors.js';
export type { CronJobEvent, CronJobOptions } from './types.js';

import { parseScheduleForMock, validateSchedule, validateTimezone, type CronFields, type RateSchedule, type CronSchedule } from './schedule.js';

/**
 * Scheduled task execution backed by EventBridge Scheduler and Lambda.
 *
 * **When to use:** You need to run code on a recurring schedule — cleanup
 * jobs, report generation, data syncs, cache warming, or periodic health checks.
 *
 * **When NOT to use:** If you need to run a one-off async task triggered by
 * an event or user action, use `AsyncJob`.
 *
 * **Best practices:**
 * - Keep handlers idempotent — schedules can fire twice in rare cases
 * - Use rate expressions for simple intervals (`rate(5 minutes)`)
 * - Use cron expressions for precise timing (`cron(0 9 * * ? *)`)
 * - Set `enabled: false` for jobs you only want to trigger manually during development
 *
 * **Failure handling (preview):** On a serverless compute, handler exceptions
 * are retried by Lambda's built-in async invoke retry policy (2 retries with
 * exponential backoff), with no dead-letter queue yet. On a container compute,
 * a failed tick is retried by its queue (3 attempts in total), then moved to a
 * dead-letter queue. Configurable retry policies are planned for GA.
 *
 * **Concurrent executions (preview):** If a handler runs longer than the
 * schedule interval, the next invocation starts while the previous is still
 * running. Design handlers to tolerate concurrent execution.
 *
 * **Long-running jobs:** A serverless compute stops a handler after at most 15
 * minutes. Pass a container `Compute` as `compute` (the same objects `AsyncJob`
 * accepts) with a `timeoutSeconds` to run longer. Each tick is then delivered
 * like a container `AsyncJob`: an enforced timeout, up to 3 attempts, then a
 * dead-letter queue.
 *
 * @example
 * ```typescript
 * const cleanup = new CronJob(scope, 'cleanup', {
 *   schedule: 'rate(1 hour)',
 *   handler: async (event) => {
 *     console.log(`Running cleanup at ${event.scheduledTime}`);
 *   },
 * });
 *
 * const worker = new Compute(scope, 'worker', { type: 'container', size: { vcpu: 1, memory: 2048 } });
 * new CronJob(scope, 'nightly-rebuild', {
 *   schedule: 'cron(0 3 * * ? *)',
 *   compute: worker,
 *   timeoutSeconds: 2 * 60 * 60,
 *   handler: async () => { await rebuildIndex(); },
 * });
 * ```
 */
export class CronJob<T = void> extends Scope {
	private _handler: (event: CronJobEvent<T>) => Promise<void>;
	private _input: T | undefined;
	private _timezone: string | undefined;
	private _timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null = null;
	private _schedule: RateSchedule | CronSchedule;
	private _enabled: boolean;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options: CronJobOptions<T>) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this._handler = options.handler;
		this._input = options.input;
		this._timezone = options.timezone;
		this._enabled = options.enabled !== false;
		registerSdkIdentifiers(this.fullId, { scheduleName: `mock-${this.fullId}` });

		// The synth gate first, in the same order as the CDK and AWS entries (schedule,
		// then timezone), so an input with both wrong gets the same named error.
		validateSchedule(options.schedule);
		// `!== undefined` (not truthiness) so `timezone: ''` is rejected, as at synth.
		if (options.timezone !== undefined) {
			validateTimezone(options.timezone);
		}

		// Then the mock's own parser, which also flags valid cron it can't simulate.
		this._schedule = parseScheduleForMock(options.schedule);

		if (this._enabled) {
			this._start();
		} else {
			console.log(`[CronJob:${this.id}] registered (disabled)`);
		}
	}

	private _start(): void {
		if (this._schedule.type === 'rate') {
			console.log(`[CronJob:${this.id}] scheduled: rate(${formatMs(this._schedule.intervalMs)})`);
			// Slots count from the start time at whole seconds; `_fire` drops milliseconds either way.
			const startMs = Math.floor(Date.now() / 1000) * 1000;
			const intervalMs = this._schedule.intervalMs;
			if (intervalMs > MAX_TIMEOUT_MS) {
				this._scheduleLongRateTick(startMs + intervalMs);
			} else {
				let lastSlot = 0;
				this._timer = setInterval(() => {
					// Count slots from the wall clock, not from ticks: a suspended machine
					// pauses the interval, and the next run reports the latest slot due.
					lastSlot = Math.max(lastSlot + 1, Math.floor((Date.now() - startMs) / intervalMs));
					this._fire(startMs + lastSlot * intervalMs);
				}, intervalMs);
				(this._timer as NodeJS.Timeout).unref();
			}
		} else {
			this._scheduleCronTick();
		}
	}

	/**
	 * Fires a rate schedule longer than `setTimeout`/`setInterval` allow (about 24.8 days). Node
	 * clamps a longer delay to 1 ms, so wait for `fireAt` in steps, then fire and schedule the next one.
	 * If the clock jumped past several intervals (for example the machine was asleep), the handler runs
	 * once, with `scheduledTime` set to the latest slot that was due, and the next run is the first
	 * later slot on the same cadence: like EventBridge Scheduler, the mock does not run the slots it
	 * missed.
	 */
	private _scheduleLongRateTick(fireAt: number): void {
		const delayMs = fireAt - Date.now();
		if (delayMs > MAX_TIMEOUT_MS) {
			this._timer = setTimeout(() => this._scheduleLongRateTick(fireAt), MAX_TIMEOUT_MS);
		} else {
			this._timer = setTimeout(
				() => {
					const intervalMs = (this._schedule as RateSchedule).intervalMs;
					const missedSlots = Math.max(Math.floor((Date.now() - fireAt) / intervalMs), 0);
					// After missed slots the one run reports the latest slot that was due.
					this._fire(fireAt + missedSlots * intervalMs);
					this._scheduleLongRateTick(fireAt + (missedSlots + 1) * intervalMs);
				},
				Math.max(delayMs, 0),
			);
		}
		(this._timer as NodeJS.Timeout).unref();
	}

	private _scheduleCronTick(): void {
		const now = new Date();
		const sched = this._schedule as CronSchedule;
		const next = nextCronTime(sched.fields, now, this._timezone);
		if (next === null) {
			// Nothing matches within the search window (e.g. a leap day years away):
			// search again later instead of firing on a date the schedule doesn't match.
			// A day that never exists (Feb 30) is rejected in the constructor instead.
			console.log(`[CronJob:${this.id}] no fire time within a year, checking again later`);
			this._timer = setTimeout(() => this._scheduleCronTick(), MAX_TIMEOUT_MS);
			(this._timer as NodeJS.Timeout).unref();
			return;
		}
		const delayMs = next.getTime() - now.getTime();
		const tzLabel = this._timezone ?? 'UTC';
		console.log(`[CronJob:${this.id}] next fire: ${next.toISOString()} ${tzLabel}`);
		if (delayMs > MAX_TIMEOUT_MS) {
			// setTimeout fires right away for delays above its maximum, so wait in steps.
			this._timer = setTimeout(() => this._scheduleCronTick(), MAX_TIMEOUT_MS);
		} else {
			this._timer = setTimeout(() => {
				this._fire(next.getTime());
				this._scheduleCronTick();
			}, Math.max(delayMs, 1000));
		}
		(this._timer as NodeJS.Timeout).unref();
	}

	/**
	 * Runs the handler for the schedule slot `slotMs`. The event carries the slot, not the
	 * time the timer ran (timers run a few ms late), formatted without milliseconds as
	 * EventBridge Scheduler's `<aws.scheduler.scheduled-time>` is (`2026-03-01T00:10:00Z`).
	 */
	private _fire(slotMs: number): void {
		const event: CronJobEvent<T> = {
			scheduledTime: new Date(slotMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
			jobName: this.fullId,
			input: this._input as T,
		};
		console.log(`[CronJob:${this.id}] triggered at ${event.scheduledTime}`);
		this._handler(event).catch((err: any) => {
			console.error(`[CronJob:${this.id}] handler error: ${err?.message ?? err}`);
			console.warn(
				`[CronJob:${this.id}] In AWS, this invocation would be retried: by Lambda's async invoke retry policy on a serverless compute, or by its queue (then a dead-letter queue) on a container compute.`,
			);
		});
	}
}

// ---------------------------------------------------------------------------
// Cron next-fire-time calculation
// ---------------------------------------------------------------------------

/** Largest delay `setTimeout` accepts; longer delays fire immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Returns the next matching minute within a year after `after`, or `null` if there is none. */
function nextCronTime(fields: CronFields, after: Date, timezone?: string): Date | null {
	// Work in the target timezone by converting to local components
	const candidate = new Date(after.getTime() + 60_000); // start 1 minute ahead
	candidate.setSeconds(0, 0);

	for (let i = 0; i < 525_600; i++) { // max 1 year of minutes
		const { minute, hour, day, month, dow } = getComponents(candidate, timezone);

		if (
			fields.minute.includes(minute) &&
			fields.hour.includes(hour) &&
			fields.month.includes(month + 1) &&
			(fields.dayOfMonth.length === 0 || fields.dayOfMonth.includes(day)) &&
			(fields.dayOfWeek.length === 0 || fields.dayOfWeek.includes(dow))
		) {
			return candidate;
		}

		candidate.setTime(candidate.getTime() + 60_000);
	}

	return null;
}

function getComponents(date: Date, timezone?: string): { minute: number; hour: number; day: number; month: number; dow: number } {
	if (!timezone) {
		return { minute: date.getUTCMinutes(), hour: date.getUTCHours(), day: date.getUTCDate(), month: date.getUTCMonth(), dow: date.getUTCDay() };
	}
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		hour: 'numeric', minute: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short',
		hour12: false,
	}).formatToParts(date);

	const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
	const dowStr = parts.find(p => p.type === 'weekday')?.value ?? 'Sun';
	const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

	return { minute: get('minute'), hour: get('hour'), day: get('day'), month: get('month') - 1, dow: dowMap[dowStr] ?? 0 };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
	if (ms >= 86_400_000) return `${ms / 86_400_000} day(s)`;
	if (ms >= 3_600_000) return `${ms / 3_600_000} hour(s)`;
	return `${ms / 60_000} minute(s)`;
}
