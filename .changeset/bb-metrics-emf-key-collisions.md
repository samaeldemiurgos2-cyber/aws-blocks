---
'@aws-cdk-blocks/bb-metrics': minor
'aws-cdk-blocks': minor
---

`emit` and `emitBatch` now write every data point to its own EMF key without overwriting dimensions or the `_aws` envelope.

- A metric name equal to one of its dimension keys, or a metric name or dimension key of `_aws`, now throws `MetricsErrors.InvalidMetricName` or `MetricsErrors.InvalidDimensions`. Previously the metric value replaced the dimension value or the EMF metadata, so the metric was not published.
- A metric name repeated in one `emitBatch` call is written to a separate EMF document, so every value is recorded. Previously only the last value was kept. Metrics that hit this record more data points after upgrading, so their `Sum` and `SampleCount` statistics go up.
- Dimension sets are grouped by an unambiguous key, so `{ a: '1&b=2' }` and `{ a: '1', b: '2' }` are no longer reported under the same dimensions.
- Metrics with different timestamps in one batch are written with their own timestamps instead of the first metric's.
- A value that is not a finite number (`NaN`, `Infinity`) or a timestamp that is not a valid `Date` is now left out of the document with a warning through the `logger` option, and the rest of the batch is still written. Previously it was written as `null`, and an invalid timestamp made CloudWatch skip the whole document. Nothing is thrown, so a ratio that is `NaN` at zero traffic does not fail the request.
- `MetricUnit` now lists all 27 units CloudWatch accepts, including `Count/Second`, `Bytes/Second` and `Terabytes`. A unit outside that list throws the new `MetricsErrors.InvalidUnit`. Previously it was passed through unchecked.
- A metric named `__proto__` now gets its own value key instead of being written without a value.
