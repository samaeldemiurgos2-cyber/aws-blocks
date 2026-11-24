// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { blocksError } from '@aws-cdk-blocks/core';
import { MetricsErrors } from './errors.js';
import type { MetricUnit } from './types.js';

/**
 * Top-level EMF key that holds the metadata envelope. Metric values and
 * dimension values are written next to it, so neither may use this name.
 */
const EMF_ENVELOPE_KEY = '_aws';

/** Every `MetricUnit` value, checked at runtime for callers that bypass the type. */
const METRIC_UNITS = [
	'Count',
	'Seconds',
	'Milliseconds',
	'Microseconds',
	'Bytes',
	'Kilobytes',
	'Megabytes',
	'Gigabytes',
	'Terabytes',
	'Bits',
	'Kilobits',
	'Megabits',
	'Gigabits',
	'Terabits',
	'Percent',
	'Bytes/Second',
	'Kilobytes/Second',
	'Megabytes/Second',
	'Gigabytes/Second',
	'Terabytes/Second',
	'Bits/Second',
	'Kilobits/Second',
	'Megabits/Second',
	'Gigabits/Second',
	'Terabits/Second',
	'Count/Second',
	'None',
] as const satisfies readonly MetricUnit[];

// Compile-time check that METRIC_UNITS lists every MetricUnit member.
type MissingUnits = Exclude<MetricUnit, (typeof METRIC_UNITS)[number]>;
const _allUnitsListed: [MissingUnits] extends [never] ? true : MissingUnits = true;
void _allUnitsListed;

const METRIC_UNIT_SET: ReadonlySet<string> = new Set(METRIC_UNITS);

/**
 * Validate a metric name against CloudWatch constraints.
 * - Must be non-empty
 * - Max 1024 characters
 * - Must not be `_aws` (the EMF envelope key)
 */
export function validateMetricName(name: string): void {
	if (!name || name.length === 0) {
		throw blocksError(MetricsErrors.InvalidMetricName, 'Metric name must not be empty');
	}
	if (name.length > 1024) {
		throw blocksError(MetricsErrors.InvalidMetricName, `Metric name exceeds 1024 characters (got ${name.length})`);
	}
	if (name === EMF_ENVELOPE_KEY) {
		throw blocksError(MetricsErrors.InvalidMetricName, `Metric name '${EMF_ENVELOPE_KEY}' is reserved by the EMF format`);
	}
}

/**
 * Validate that a metric name does not equal one of its own dimension keys.
 * EMF writes both at the top level of the same JSON document, so a clash
 * would overwrite the dimension value with the metric value.
 */
export function validateNameDimensionClash(name: string, dimensions: Record<string, string>): void {
	if (Object.hasOwn(dimensions, name)) {
		throw blocksError(
			MetricsErrors.InvalidMetricName,
			`Metric name '${name.substring(0, 50)}' must not equal one of its dimension keys`,
		);
	}
}

/**
 * Why a data point built from runtime data cannot be published, or `undefined` if it can.
 * - The value must be a finite number (`NaN`, `Infinity` and `-Infinity` serialize to `null` in JSON)
 * - A timestamp, when given, must be a valid `Date` (an invalid one serializes to `null`)
 *
 * These are not thrown: a ratio such as `errors / total` is `NaN` at zero traffic, and a
 * metrics call must not fail the request it observes. Callers drop the data point instead.
 */
export function unpublishableReason(value: number, timestamp?: Date): string | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return `value ${String(value).substring(0, 50)} is not a finite number`;
	}
	if (timestamp !== undefined && !(timestamp instanceof Date && Number.isFinite(timestamp.getTime()))) {
		return 'timestamp is not a valid Date';
	}
	return undefined;
}

/**
 * Validate a metric unit.
 * - Must be one of the `MetricUnit` values
 */
export function validateUnit(unit: string): void {
	if (!METRIC_UNIT_SET.has(unit)) {
		throw blocksError(
			MetricsErrors.InvalidUnit,
			`Metric unit '${String(unit).substring(0, 50)}' is not supported. Valid: ${METRIC_UNITS.join(', ')}`,
		);
	}
}

/**
 * Validate dimensions against CloudWatch constraints.
 * - Max 30 dimension key-value pairs
 * - Keys and values must be non-empty
 * - Keys and values max 1024 characters each
 * - Keys must not be `_aws` (the EMF envelope key)
 */
export function validateDimensions(dimensions: Record<string, string>): void {
	const entries = Object.entries(dimensions);
	if (entries.length > 30) {
		throw blocksError(MetricsErrors.InvalidDimensions, `Dimensions exceed 30 entries (got ${entries.length})`);
	}
	for (const [key, value] of entries) {
		if (!key || key.length === 0) {
			throw blocksError(MetricsErrors.InvalidDimensions, 'Dimension key must not be empty');
		}
		if (key === EMF_ENVELOPE_KEY) {
			throw blocksError(MetricsErrors.InvalidDimensions, `Dimension key '${EMF_ENVELOPE_KEY}' is reserved by the EMF format`);
		}
		if (key.length > 1024) {
			throw blocksError(MetricsErrors.InvalidDimensions, `Dimension key exceeds 1024 characters: '${key.substring(0, 50)}...'`);
		}
		if (value === undefined || value === null || value.length === 0) {
			throw blocksError(MetricsErrors.InvalidDimensions, `Dimension value for key '${key}' must not be empty`);
		}
		if (value.length > 1024) {
			throw blocksError(MetricsErrors.InvalidDimensions, `Dimension value for key '${key}' exceeds 1024 characters`);
		}
	}
}

/**
 * Validate batch size (max 100 metrics per EMF document).
 */
export function validateBatchSize(count: number): void {
	if (count > 100) {
		throw blocksError(MetricsErrors.BatchTooLarge, `Batch exceeds 100 metrics (got ${count})`);
	}
}

/** Valid characters for a CloudWatch namespace: alphanumeric, dot, underscore, hash, colon, slash, hyphen, space. */
const NAMESPACE_PATTERN = /^[a-zA-Z0-9._#:/ -]+$/;

/**
 * Validate a namespace against CloudWatch constraints.
 * - Must be non-empty (at least one non-whitespace character)
 * - Max 256 characters
 * - Only valid chars: [a-zA-Z0-9._#:/ -]
 * - Must not start with "AWS/" (reserved for AWS services)
 */
export function validateNamespace(namespace: string): void {
	if (!namespace || namespace.trim().length === 0) {
		throw blocksError(MetricsErrors.InvalidNamespace, 'Namespace must not be empty');
	}
	if (namespace.length > 256) {
		throw blocksError(MetricsErrors.InvalidNamespace, `Namespace exceeds 256 characters (got ${namespace.length})`);
	}
	if (!NAMESPACE_PATTERN.test(namespace)) {
		throw blocksError(MetricsErrors.InvalidNamespace, `Namespace contains invalid characters: '${namespace.substring(0, 50)}'. Valid: [a-zA-Z0-9._#:/ -]`);
	}
	if (namespace.startsWith('AWS/')) {
		throw blocksError(MetricsErrors.InvalidNamespace, `Namespace must not start with 'AWS/' (reserved for AWS services): '${namespace}'`);
	}
}

/**
 * Merge default dimensions with per-emit dimensions.
 * Per-emit dimensions take precedence on key conflict.
 */
export function mergeDimensions(
	defaults: Record<string, string>,
	overrides?: Record<string, string>,
): Record<string, string> {
	if (!overrides || Object.keys(overrides).length === 0) return { ...defaults };
	return { ...defaults, ...overrides };
}
