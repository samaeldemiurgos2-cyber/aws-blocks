// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope } from '@aws-cdk-blocks/core';
import { getMockDataDir, assertNotMockInDeployedEnv } from '@aws-cdk-blocks/core/bb-utils';
import type { ScopeParent } from '@aws-cdk-blocks/core';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TracerOptions, Segment as ISegment, AnnotationValue } from './types.js';
import { Logger } from '@aws-cdk-blocks/bb-logger';
import type { ChildLogger } from '@aws-cdk-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';

// Fail closed if this mock entry loads in a deployed env — see assertNotMockInDeployedEnv.
assertNotMockInDeployedEnv('bb-tracer');

export type { TracerOptions, Segment, AnnotationValue } from './types.js';

// ── Internal Types ──────────────────────────────────────────────────────────

interface TraceRecord {
	traceId: string;
	segment: string;
	startTime: number;
	endTime: number;
	durationMs: number;
	annotations: Record<string, AnnotationValue>;
	metadata: Record<string, unknown>;
	error?: { name: string; message: string };
	httpStatus?: number;
	children: TraceRecord[];
	rootAnnotations?: Record<string, AnnotationValue>;
	rootMetadata?: Record<string, unknown>;
}

/** State shared by every segment of one trace (one top-level `startSegment` call). */
interface TraceState {
	traceId: string;
	/** Sampling decision rolled once at the root and inherited by every subsegment. */
	sampled: boolean;
	rootAnnotations: Record<string, AnnotationValue>;
	rootMetadata: Record<string, unknown>;
}

/** The async context a segment's `fn` runs in. */
interface SegmentContext {
	trace: TraceState;
	/** Record of the enclosing segment; `null` in an unsampled trace, which records nothing. */
	parent: TraceRecord | null;
}

/**
 * Convert a thrown or reported value into the `{ name, message }` the mock
 * records, following what X-Ray's `Subsegment.addError` accepts: a string is
 * recorded as the message, an object contributes its string `name` and
 * `message`, and anything else (`undefined`, `null`, numbers, booleans, ...)
 * records no error. Never throws, so recording cannot replace the value the
 * caller threw.
 */
function toRecordedError(error: unknown): { name: string; message: string } | undefined {
	if (typeof error === 'string' || error instanceof String) {
		return { name: '', message: String(error) };
	}
	if (error === null || typeof error !== 'object') return undefined;
	try {
		const name = 'name' in error && typeof error.name === 'string' ? error.name : '';
		const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
		return { name, message };
	} catch {
		// A throwing getter or Proxy trap: record that an error happened without its details.
		return { name: '', message: '' };
	}
}

// ── Mock Segment ────────────────────────────────────────────────────────────

class MockSegment implements ISegment {
	public annotations: Record<string, AnnotationValue> = {};
	public metadata: Record<string, unknown> = {};
	public error?: { name: string; message: string };
	public httpStatus?: number;

	addAnnotation(key: string, value: AnnotationValue): void {
		this.annotations[key] = value;
	}

	addMetadata(key: string, value: unknown): void {
		this.metadata[key] = value;
	}

	// Accepts `unknown` (wider than `ISegment`'s `Error`) because `startSegment`
	// passes whatever `fn` threw, and JavaScript callers can pass anything.
	addError(error: unknown): void {
		const recorded = toRecordedError(error);
		if (recorded) this.error = recorded;
	}

	setHttpStatus(statusCode: number): void {
		this.httpStatus = statusCode;
	}
}

// ── Tracer (mock) ──────────────────────────────────────────────────────────

/**
 * Distributed tracing backed by AWS X-Ray.
 *
 * **When to use:** You need to trace request flow across services, debug
 * latency issues, or visualize service dependencies. Good for identifying
 * bottlenecks, understanding call chains, and correlating failures across
 * Building Blocks.
 *
 * **When NOT to use:** If you need structured log output, use `Logging`. If
 * you need numeric measurements over time, use `Metrics`.
 *
 * **Best practices:**
 * - Use `startSegment` to wrap discrete units of work (DB calls, HTTP requests, business logic)
 * - Keep segment names short and descriptive (e.g., `'fetchUser'`, `'processPayment'`)
 * - Use annotations for values you want to filter/search by in the X-Ray console
 * - Use metadata for large or complex debugging data you don't need to search
 * - Keep annotation cardinality low (avoid user-specific values as annotation keys)
 *
 * **Scaling:** No throughput limits from the BB itself. X-Ray sampling controls
 * trace volume. Cost is per trace recorded and per trace retrieved. Use
 * `samplingRate` to control volume in high-throughput scenarios.
 */
export class Tracer extends Scope {
	private enabled: boolean;
	private samplingRate: number;
	private tracesFilePath: string;
	/**
	 * Trace ID, annotations and metadata set *outside* any segment (e.g.
	 * `getTraceId()` or `addAnnotation()` before the request's root segment
	 * starts). The next top-level `startSegment` adopts them as its trace state.
	 */
	private currentTraceId: string | null = null;
	private rootAnnotations: Record<string, AnnotationValue> = {};
	private rootMetadata: Record<string, unknown> = {};
	/**
	 * The trace and parent segment of the running `startSegment` call. Kept in
	 * async context rather than instance fields so overlapping top-level
	 * segments (concurrent dev-server requests) each get their own trace, and
	 * nested segments attach to the parent in their own async chain. An
	 * unsampled trace has a context too, so its subsegments stay unsampled
	 * rather than re-rolling and spawning their own root traces.
	 */
	private context = new AsyncLocalStorage<SegmentContext>();

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: TracerOptions) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.enabled = options?.enabled !== false;
		const rate = options?.samplingRate ?? 1.0;
		if (rate < 0 || rate > 1) {
			throw new RangeError('samplingRate must be between 0 and 1');
		}
		this.samplingRate = rate;
		this.tracesFilePath = join(getMockDataDir(this), 'traces.json');
	}

	/**
	 * Wrap an async function in a traced subsegment.
	 * The segment is automatically closed when fn completes or throws.
	 * Errors are recorded on the segment and re-thrown.
	 *
	 * @param name - Human-readable name for the segment (e.g., 'fetchUser').
	 * @param fn - Async function to execute within the traced segment.
	 * @returns The return value of `fn`.
	 */
	async startSegment<T>(name: string, fn: (segment: ISegment) => Promise<T>): Promise<T> {
		if (!this.enabled) {
			return fn(NO_OP_SEGMENT);
		}

		// Sampling is a per-trace decision: roll it once at the root segment and
		// have every subsegment inherit it, so a trace is recorded whole or not
		// at all. Rolling per subsegment (the previous behavior) would randomly
		// drop children from a sampled trace, or promote a subsegment of an
		// unsampled trace into its own orphan root trace.
		const parentContext = this.context.getStore();
		const isTopLevel = parentContext === undefined;
		const trace = parentContext?.trace ?? this.beginTrace(this.shouldSample());
		if (!trace.sampled) {
			return this.context.run({ trace, parent: null }, () => fn(NO_OP_SEGMENT));
		}

		const segment = new MockSegment();
		const startTime = Date.now();

		// Create a placeholder record; it becomes the parent of segments started inside fn
		const record: TraceRecord = {
			traceId: trace.traceId,
			segment: name,
			startTime,
			endTime: 0,
			durationMs: 0,
			annotations: {},
			metadata: {},
			children: [],
		};

		// If there's a parent segment in this async chain, add this as a child
		if (parentContext?.parent) {
			parentContext.parent.children.push(record);
		}

		try {
			const result = await this.context.run({ trace, parent: record }, () => fn(segment));
			const endTime = Date.now();

			this.finalizeRecord(record, endTime, segment);

			if (isTopLevel) {
				record.rootAnnotations = { ...trace.rootAnnotations };
				record.rootMetadata = { ...trace.rootMetadata };
				this.persistTrace(record);
				this.logTrace(record);
			}

			return result;
		} catch (error) {
			const endTime = Date.now();
			// `error` can be any value (`throw undefined` is legal); addError
			// records what it can and the original value is rethrown unchanged.
			segment.addError(error);

			this.finalizeRecord(record, endTime, segment);

			if (isTopLevel) {
				record.rootAnnotations = { ...trace.rootAnnotations };
				record.rootMetadata = { ...trace.rootMetadata };
				this.persistTrace(record);
				this.logTrace(record);
			}

			throw error;
		}
	}

	/**
	 * Add a searchable annotation to the current root segment.
	 * In AWS: adds to the Lambda facade segment.
	 * In mock: adds to the top-level trace record.
	 *
	 * @param key - Annotation key.
	 * @param value - String, number, or boolean value.
	 */
	addAnnotation(key: string, value: AnnotationValue): void {
		if (!this.enabled) return;
		// Inside a segment: the running trace. Outside: held for the next trace.
		const target = this.context.getStore()?.trace.rootAnnotations ?? this.rootAnnotations;
		target[key] = value;
	}

	/**
	 * Add non-searchable metadata to the current root segment.
	 *
	 * @param key - Metadata key.
	 * @param value - Any JSON-serializable value.
	 */
	addMetadata(key: string, value: unknown): void {
		if (!this.enabled) return;
		// Inside a segment: the running trace. Outside: held for the next trace.
		const target = this.context.getStore()?.trace.rootMetadata ?? this.rootMetadata;
		target[key] = value;
	}

	/**
	 * Get the current trace ID, or null if tracing is disabled / no active trace.
	 * Useful for correlating logs with traces.
	 *
	 * In AWS: returns the X-Ray trace ID from _X_AMZN_TRACE_ID.
	 * In mock: returns a generated UUID trace ID.
	 */
	getTraceId(): string | null {
		if (!this.enabled) return null;
		const active = this.context.getStore();
		if (active) return active.trace.traceId;
		if (!this.currentTraceId) {
			this.currentTraceId = randomUUID();
		}
		return this.currentTraceId;
	}

	// ── Private helpers ─────────────────────────────────────────────────────

	private shouldSample(): boolean {
		return Math.random() < this.samplingRate;
	}

	/**
	 * Start the state for a new top-level trace. It takes over the trace ID,
	 * annotations and metadata set outside any segment, and resets them so the
	 * following trace starts clean.
	 */
	private beginTrace(sampled: boolean): TraceState {
		const trace: TraceState = {
			traceId: this.currentTraceId ?? randomUUID(),
			sampled,
			rootAnnotations: this.rootAnnotations,
			rootMetadata: this.rootMetadata,
		};
		this.currentTraceId = null;
		this.rootAnnotations = {};
		this.rootMetadata = {};
		return trace;
	}

	private finalizeRecord(record: TraceRecord, endTime: number, segment: MockSegment): void {
		record.endTime = endTime;
		record.durationMs = endTime - record.startTime;
		record.annotations = { ...segment.annotations };
		record.metadata = { ...segment.metadata };
		if (segment.error) record.error = segment.error;
		if (segment.httpStatus !== undefined) record.httpStatus = segment.httpStatus;
	}

	private persistTrace(record: TraceRecord): void {
		let traces: TraceRecord[] = [];
		if (existsSync(this.tracesFilePath)) {
			try {
				traces = JSON.parse(readFileSync(this.tracesFilePath, 'utf8'));
			} catch { /* corrupted file — start fresh */ }
		}
		traces.push(record);
		if (traces.length > 100) {
			traces = traces.slice(-100);
		}
		writeFileSync(this.tracesFilePath, JSON.stringify(traces, null, 2));
	}

	private logTrace(record: TraceRecord): void {
		console.log(JSON.stringify({
			_type: 'trace',
			traceId: record.traceId,
			segment: record.segment,
			durationMs: record.durationMs,
			annotations: Object.keys(record.annotations).length > 0 ? record.annotations : undefined,
			metadata: Object.keys(record.metadata).length > 0 ? record.metadata : undefined,
			error: record.error,
			httpStatus: record.httpStatus,
		}, null, 2));
	}
}

// No-op segment for disabled/unsampled traces
const NO_OP_SEGMENT: ISegment = {
	addAnnotation() {},
	addMetadata() {},
	addError() {},
	setHttpStatus() {},
};
