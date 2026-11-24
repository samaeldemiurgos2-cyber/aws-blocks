// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed error constants for Metrics. Use with `isBlocksError()` in catch blocks.
 *
 * @example
 * ```typescript
 * import { isBlocksError } from '@aws-cdk-blocks/core';
 * import { MetricsErrors } from '@aws-cdk-blocks/bb-metrics';
 *
 * try {
 *   metrics.emit('', 1);
 * } catch (e) {
 *   if (isBlocksError(e, MetricsErrors.InvalidMetricName)) {
 *     // handle invalid metric name
 *   }
 * }
 * ```
 */
export const MetricsErrors = {
	/**
	 * Metric name is empty, exceeds 1024 characters, is the reserved `_aws` key,
	 * or equals one of the data point's own dimension keys.
	 */
	InvalidMetricName: 'InvalidMetricNameException',
	/**
	 * Dimensions exceed 30 entries, or contain empty keys/values, or key/value exceeds 1024 chars,
	 * or use the reserved `_aws` key.
	 */
	InvalidDimensions: 'InvalidDimensionsException',
	/** Metric unit is not one of the `MetricUnit` values. */
	InvalidUnit: 'InvalidUnitException',
	/** Batch contains more than 100 metrics. */
	BatchTooLarge: 'BatchTooLargeException',
	/** Namespace is empty, too long, contains invalid characters, or uses reserved AWS/ prefix. */
	InvalidNamespace: 'InvalidNamespaceException',
} as const;
