// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope } from '@aws-cdk-blocks/core';
import type { ScopeParent } from '@aws-cdk-blocks/core';
import type {
	MetricsOptions,
	EmitOptions,
	MetricDatum,
	MetricUnit,
	MetricResolution,
	ExternalMetricsRef,
	MetricsEmitter,
} from './types.js';
import { externalMetricsRef } from './from-existing.js';
import { MetricsErrors } from './errors.js';
import { BB_NAME, BB_VERSION } from './version.js';
import {
	validateMetricName,
	validateDimensions,
	validateBatchSize,
	validateNamespace,
	validateNameDimensionClash,
	unpublishableReason,
	validateUnit,
	mergeDimensions,
} from './validation.js';
import { Logger } from '@aws-cdk-blocks/bb-logger';
import type { ChildLogger } from '@aws-cdk-blocks/bb-logger';

export { MetricsErrors } from './errors.js';
export type {
	MetricsOptions,
	EmitOptions,
	MetricDatum,
	MetricUnit,
	MetricResolution,
	ExternalMetricsRef,
	MetricsEmitter,
} from './types.js';

// ── Metrics (AWS runtime via EMF) ───────────────────────────────────────────

/**
 * Custom application metrics backed by Amazon CloudWatch (via EMF).
 *
 * Metrics emitted from this Building Block appear in CloudWatch under the
 * configured namespace. Use for dashboards, alarms, and operational visibility.
 *
 * Uses CloudWatch Embedded Metric Format (EMF) — writes metric data as
 * structured JSON to stdout. Lambda captures these and CloudWatch extracts
 * metrics automatically.
 *
 * **When to use:** You need to track numeric measurements over time — request
 * counts, error rates, latency, queue depths, business KPIs.
 *
 * **When NOT to use:** If you need structured log output only, use `Logging`.
 * If you need distributed request tracing, use `Tracing`. If you need to store
 * time-series data for querying, use `Database` or `KVStore`.
 *
 * **Best practices:**
 * - Keep dimension cardinality low (avoid user IDs or request IDs as dimensions)
 * - Use consistent metric names across your application
 * - Use `defaultDimensions` for shared context (service name, environment)
 * - Prefer `emitBatch` when recording multiple metrics in a single request
 * - Use units to enable automatic conversions in CloudWatch dashboards
 *
 * **Scaling:** CloudWatch accepts unlimited metrics via EMF. Standard resolution
 * metrics (60s) are retained for 15 days; high-resolution (1s) for 3 hours,
 * then aggregated. Costs scale with unique metric name + dimension combinations.
 *
 * **Local development:** Metrics are written as EMF JSON to stdout (same as AWS).
 * No disk persistence — metrics are ephemeral in local dev.
 *
 * **⚠️ Synchronous:** All metric methods are synchronous (void, not Promise).
 * EMF writes to stdout which Lambda captures asynchronously. Returning a Promise
 * would add overhead for zero benefit.
 *
 * @example
 * ```typescript
 * import { Metrics } from '@aws-cdk-blocks/bb-metrics';
 *
 * const metrics = new Metrics(scope, 'appMetrics', {
 *   namespace: 'MyApp/Orders',
 *   defaultDimensions: { service: 'orders' },
 * });
 *
 * metrics.emit('RequestCount', 1, { unit: 'Count' });
 * metrics.emit('Latency', 42, { unit: 'Milliseconds' });
 * ```
 */
export class Metrics extends Scope implements MetricsEmitter {
	/** The resolved CloudWatch namespace for metrics emitted by this instance. */
	readonly namespace: string;
	/** Dimensions applied to every metric emitted by this instance. */
	readonly defaultDimensions: Readonly<Record<string, string>>;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: MetricsOptions) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.namespace = options?.metrics?.namespace
			?? options?.namespace
			?? this.fullId;
		this.defaultDimensions = options?.defaultDimensions ?? {};
		validateNamespace(this.namespace);
	}

	/**
	 * Record a single metric data point via EMF.
	 *
	 * @param name - Metric name (e.g., 'RequestCount', 'Latency'). Non-empty, max 1024 chars.
	 * @param value - Numeric value to record.
	 * @param options - Unit, dimensions, timestamp, and resolution.
	 * @throws {MetricsErrors.InvalidMetricName} If the metric name is empty or exceeds 1024 characters.
	 * @throws {MetricsErrors.InvalidMetricName} If the metric name is `_aws` or equals one of its dimension keys.
	 * @throws {MetricsErrors.InvalidDimensions} If dimensions exceed 30 entries or contain empty keys/values.
	 * @throws {MetricsErrors.InvalidDimensions} If a dimension key is `_aws`.
	 * @throws {MetricsErrors.InvalidUnit} If the unit is not a `MetricUnit` value.
	 *
	 * A value that is not a finite number (`NaN`, `Infinity`), or a timestamp that is not a
	 * valid `Date`, does not throw: the data point is not written and a warning is logged
	 * through the configured logger.
	 *
	 * @example
	 * ```typescript
	 * metrics.emit('RequestCount', 1);
	 * metrics.emit('Latency', 42, { unit: 'Milliseconds' });
	 * metrics.emit('ErrorRate', 0.05, {
	 *   unit: 'Percent',
	 *   dimensions: { endpoint: '/api/orders' },
	 * });
	 * ```
	 */
	emit(name: string, value: number, options?: EmitOptions): void {
		emitData(this.namespace, this.defaultDimensions, this.log, [{ ...options, name, value }]);
	}

	/**
	 * Record multiple metric data points in a single EMF document.
	 * Metrics with the same dimension set are grouped into one EMF entry.
	 * Metrics with different timestamps go into separate entries, and a metric
	 * name repeated within a group goes into another entry so every value is kept.
	 * Every data point is validated before anything is written. A data point whose value
	 * is not a finite number, or whose timestamp is not a valid `Date`, is left out with a
	 * logged warning and the rest of the batch is still written.
	 *
	 * @param metrics - Array of metric data points (max 100 per call).
	 * @throws {MetricsErrors.InvalidMetricName} If any metric name is invalid.
	 * @throws {MetricsErrors.InvalidDimensions} If any metric's dimensions are invalid.
	 * @throws {MetricsErrors.InvalidUnit} If any unit is not a `MetricUnit` value.
	 * @throws {MetricsErrors.BatchTooLarge} If the batch exceeds 100 metrics.
	 *
	 * @example
	 * ```typescript
	 * metrics.emitBatch([
	 *   { name: 'RequestCount', value: 1, unit: 'Count' },
	 *   { name: 'Latency', value: 42, unit: 'Milliseconds' },
	 *   { name: 'ErrorCount', value: 0, unit: 'Count' },
	 * ]);
	 * ```
	 */
	emitBatch(metrics: MetricDatum[]): void {
		validateBatchSize(metrics.length);

		emitData(this.namespace, this.defaultDimensions, this.log, metrics);
	}

	/**
	 * No-op. EMF writes are synchronous stdout writes — no buffering to flush.
	 */
	flush(): void {}

	/**
	 * Create a child Metrics emitter with inherited namespace and dimensions.
	 * The child merges the provided dimensions on top of the parent's defaults.
	 *
	 * @param dimensions - Additional dimensions for the child instance.
	 * @returns A MetricsEmitter with merged dimensions.
	 *
	 * @example
	 * ```typescript
	 * const requestMetrics = metrics.child({ endpoint: '/api/users', method: 'GET' });
	 * requestMetrics.emit('RequestCount', 1);
	 * ```
	 */
	child(dimensions: Record<string, string>): MetricsEmitter {
		return new ChildMetrics(
			this.namespace,
			{ ...this.defaultDimensions, ...dimensions },
			this.log,
		);
	}

	/**
	 * Reference an existing CloudWatch namespace not managed by this Building Block.
	 *
	 * @param namespace - The CloudWatch namespace string.
	 *
	 * @example
	 * ```typescript
	 * const metrics = new Metrics(scope, 'legacy', {
	 *   metrics: Metrics.fromExisting('MyOrg/SharedMetrics'),
	 * });
	 * ```
	 */
	static fromExisting(namespace: string): ExternalMetricsRef {
		return externalMetricsRef(namespace);
	}
}

// ── ChildMetrics ────────────────────────────────────────────────────────────

class ChildMetrics implements MetricsEmitter {
	constructor(
		private namespace: string,
		readonly defaultDimensions: Readonly<Record<string, string>>,
		private log: ChildLogger,
	) {}

	emit(name: string, value: number, options?: EmitOptions): void {
		emitData(this.namespace, this.defaultDimensions, this.log, [{ ...options, name, value }]);
	}

	emitBatch(metrics: MetricDatum[]): void {
		validateBatchSize(metrics.length);

		emitData(this.namespace, this.defaultDimensions, this.log, metrics);
	}

	flush(): void {}

	child(dimensions: Record<string, string>): MetricsEmitter {
		return new ChildMetrics(
			this.namespace,
			{ ...this.defaultDimensions, ...dimensions },
			this.log,
		);
	}
}

// ── EMF Writer ──────────────────────────────────────────────────────────────

interface ResolvedMetric {
	name: string;
	value: number;
	unit: MetricUnit;
	dimensions: Record<string, string>;
	timestamp?: Date;
	resolution: MetricResolution;
}

/** One EMF document: a single dimension set and timestamp, each metric name at most once. */
interface MetricGroup {
	dimensions: Record<string, string>;
	timestamp?: Date;
	metrics: ResolvedMetric[];
}

/**
 * Validate one data point and resolve it against the emitter's default dimensions.
 * Shared by `emit` and `emitBatch` on both `Metrics` and `ChildMetrics`.
 */
function resolveMetric(defaultDimensions: Readonly<Record<string, string>>, datum: MetricDatum): ResolvedMetric {
	validateMetricName(datum.name);
	const unit = datum.unit ?? 'None';
	validateUnit(unit);
	const dimensions = mergeDimensions(defaultDimensions, datum.dimensions);
	validateDimensions(dimensions);
	validateNameDimensionClash(datum.name, dimensions);
	return {
		name: datum.name,
		value: datum.value,
		unit,
		dimensions,
		timestamp: datum.timestamp,
		resolution: datum.resolution ?? 'standard',
	};
}

/**
 * Validate, resolve and write data points for `emit` and `emitBatch`.
 *
 * Checks on names, dimensions and units throw for the whole call before anything
 * is written: they depend on code, not data, so they fail on the first run.
 * A non-finite value or an invalid timestamp comes from runtime data (`errors / total`
 * is `NaN` at zero traffic), so that data point is dropped with a warning and its
 * valid siblings are still written, rather than failing the request it observes.
 */
function emitData(
	namespace: string,
	defaultDimensions: Readonly<Record<string, string>>,
	log: ChildLogger,
	data: readonly MetricDatum[],
): void {
	const resolved = data.map(d => resolveMetric(defaultDimensions, d));
	const publishable: ResolvedMetric[] = [];
	for (const m of resolved) {
		const reason = unpublishableReason(m.value, m.timestamp);
		if (reason === undefined) {
			publishable.push(m);
		} else {
			log.warn(`Metric '${m.name.substring(0, 50)}' was not written: ${reason}`, { metric: m.name.substring(0, 50) });
		}
	}
	writeEmf(namespace, publishable);
}

/**
 * Write one or more metrics as EMF-formatted JSON lines to stdout.
 * Groups metrics by dimension set and timestamp (EMF requires the same
 * dimensions per entry, and each document carries a single timestamp).
 */
function writeEmf(namespace: string, metrics: ResolvedMetric[]): void {
	if (metrics.length === 0) return;

	const groups = groupMetrics(metrics);
	// One "now" per call so undated metrics in a batch share a timestamp.
	const now = Date.now();

	for (const group of groups) {
		const dimKeys = Object.keys(group.dimensions);

		// `_aws` is written first. Validation guarantees no dimension key or metric
		// name is `_aws` and no metric name equals a dimension key, so nothing
		// written below overwrites an earlier key.
		const emfPayload: Record<string, unknown> = {
			_aws: {
				Timestamp: group.timestamp?.getTime() ?? now,
				CloudWatchMetrics: [{
					Namespace: namespace,
					Dimensions: dimKeys.length > 0 ? [dimKeys] : [[]],
					Metrics: group.metrics.map(m => ({
						Name: m.name,
						Unit: m.unit,
						StorageResolution: m.resolution === 'high' ? 1 : 60,
					})),
				}],
			},
			...group.dimensions,
		};

		for (const m of group.metrics) {
			// defineProperty, not assignment: `emfPayload['__proto__'] = v` would call the
			// prototype setter and leave the metric with no value in the document.
			Object.defineProperty(emfPayload, m.name, { value: m.value, enumerable: true, writable: true, configurable: true });
		}

		process.stdout.write(JSON.stringify(emfPayload) + '\n');
	}
}

/**
 * Group metrics into EMF documents. EMF requires metrics in the same
 * CloudWatchMetrics entry to share the same dimension keys and values, and
 * each document has one timestamp. A metric name repeated within a group
 * goes into another document for that group, so every value is kept.
 */
function groupMetrics(metrics: ResolvedMetric[]): MetricGroup[] {
	const groups: MetricGroup[] = [];
	// Per group key: the documents created so far, in order, with the names each holds.
	const byKey = new Map<string, { group: MetricGroup; names: Set<string> }[]>();

	for (const m of metrics) {
		const key = groupKey(m);
		let docs = byKey.get(key);
		if (!docs) {
			docs = [];
			byKey.set(key, docs);
		}
		let doc = docs.find(d => !d.names.has(m.name));
		if (!doc) {
			doc = { group: { dimensions: m.dimensions, timestamp: m.timestamp, metrics: [] }, names: new Set() };
			docs.push(doc);
			groups.push(doc.group);
		}
		doc.group.metrics.push(m);
		doc.names.add(m.name);
	}

	return groups;
}

/**
 * Unambiguous key for a metric's dimension set and timestamp. JSON-encoding the
 * sorted entries keeps `{ a: '1&b=2' }` and `{ a: '1', b: '2' }` apart.
 */
function groupKey(m: ResolvedMetric): string {
	const sorted = Object.entries(m.dimensions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return JSON.stringify([m.timestamp?.getTime() ?? null, sorted]);
}
