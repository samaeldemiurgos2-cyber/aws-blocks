# Metrics — Design

Design document for Metrics. For usage, see [README.md](./README.md).

**Package:** `@aws-cdk-blocks/bb-metrics`
**Type:** Primitive (no new infrastructure created)
**AWS Service:** Amazon CloudWatch Metrics (via Embedded Metric Format)

## Key Design Decision: EMF over PutMetricData

Metrics are emitted using **CloudWatch Embedded Metric Format (EMF)** rather than calling the `PutMetricData` API directly.

### Why EMF?

| Concern | PutMetricData | EMF |
|---------|---------------|-----|
| **Latency impact** | HTTP call to CloudWatch (~5-50ms) | Synchronous stdout write (~0ms) |
| **IAM permissions** | Requires `cloudwatch:PutMetricData` | Uses CloudWatch Logs (Lambda has this by default) |
| **Batching** | Developer must buffer and flush | CloudWatch extracts metrics from log lines automatically |
| **Error handling** | Network failures require retries | Stdout never fails (kernel-buffered) |
| **API surface** | Async (`Promise<void>`) | Sync (`void`) — simpler DX |
| **Cost** | ~$0.01 per 1000 PutMetricData API calls + metric storage | Log ingestion (already paid) + metric storage only |
| **Cold start** | AWS SDK init adds ~100ms | Zero additional cold start |

### Trade-offs

- **No aggregation control:** EMF extracts metrics at the data point level. If you emit `Latency: 42ms` 1000 times in one invocation, CloudWatch stores 1000 data points (or groups them into a single EMF document with multiple values). With PutMetricData you could pre-aggregate into a StatisticSet.
- **Log volume:** Each emit writes a JSON line to CloudWatch Logs. High-frequency metrics increase log volume (and log storage cost). Mitigated by CloudWatch Logs Infrequent Access class or retention policies.
- **Maximum metrics per document:** EMF supports up to 100 metrics per JSON document. The `emitBatch` limit of 100 matches this constraint (vs PutMetricData's 1000 per call).

### Why the trade-offs are acceptable

1. Most BB users emit <100 metrics per invocation — log volume is negligible.
2. The simplicity of a synchronous, zero-config API far outweighs the rare need for client-side aggregation.
3. Lambda log costs are typically dominated by application logs, not metric EMF lines.

## Architecture

### Runtime Flow (AWS + Local)

```
emit('Count', 1, { dimensions: { endpoint: '/api' } })
  │
  ├─ validateMetricName('Count')
  ├─ mergeDimensions(defaults, { endpoint: '/api' })
  ├─ validateDimensions(merged)
  │
  └─ writeEmf(namespace, [{ name, value, unit, dimensions, timestamp, resolution }])
       │
       ├─ groupByDimensions(metrics)  // EMF requires same dims per entry
       │
       └─ for each group:
            process.stdout.write(JSON.stringify(emfPayload) + '\n')
```

### EMF Document Structure

```json
{
  "_aws": {
    "Timestamp": 1718450000000,
    "CloudWatchMetrics": [{
      "Namespace": "MyApp/Orders",
      "Dimensions": [["service", "endpoint"]],
      "Metrics": [
        { "Name": "RequestCount", "Unit": "Count", "StorageResolution": 60 },
        { "Name": "Latency", "Unit": "Milliseconds", "StorageResolution": 60 }
      ]
    }]
  },
  "service": "orders",
  "endpoint": "/api",
  "RequestCount": 1,
  "Latency": 42
}
```

### Dimension Grouping

EMF requires all metrics in a single `CloudWatchMetrics` entry to share the same dimension keys and values. When `emitBatch` receives metrics with different dimension sets, they are grouped and written as separate JSON lines.

The group key is the JSON encoding of the timestamp and the key-sorted dimension entries, so dimension values that contain separator characters cannot make two different sets share a group. Each document carries one `Timestamp`, so metrics with different timestamps are written as separate lines. Metric values sit next to the dimension values at the top level of the document, so a metric name repeated within a group goes into another line for that group rather than overwriting the earlier value.

### Child Emitters

`child(dimensions)` returns a lightweight `ChildMetrics` object (not a Scope node) that:
- Inherits the parent's namespace
- Merges the provided dimensions on top of the parent's `defaultDimensions`
- Supports further nesting via `child()` on the child itself

This enables per-request or per-endpoint metric scoping without creating new Scope nodes.

## Infrastructure (CDK)

Unlike most Building Blocks, Metrics does **not** create any AWS resources. CloudWatch namespaces are created implicitly on first metric data point arrival.

The CDK construct creates no AWS resources and adds no environment variables or IAM grants. EMF uses CloudWatch Logs (which Lambda already has), so no `cloudwatch:PutMetricData` grant is needed. The construct only:
1. **Resolves the namespace:** Computes the resolved `namespace` and exposes it as a readonly property.
2. **Exposes `defaultDimensions`:** Exposes `defaultDimensions` as a readonly property so that other CDK-time consumers (like the Dashboard BB) can read them and build matching CloudWatch widget queries.

### Namespace Resolution Order

```
ExternalMetricsRef.namespace  (fromExisting)
  → options.namespace  (constructor arg)
    → scope.fullId  (default)
```

## Mock Implementation

There is no separate mock — the AWS runtime (`index.aws.ts`) and the mock (`index.mock.ts`) are identical. Both write EMF JSON to stdout. In local dev, the output is visible in the terminal; in Lambda, it is captured by CloudWatch Logs.

This is unique among Building Blocks. Most BBs need a mock because their AWS runtime makes network calls (DynamoDB, S3, SQS, etc.). Metrics via EMF only writes to stdout, which works identically in all environments.

### Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| No CloudWatch extraction | Metrics are written but not extracted into CloudWatch locally | Expected — local dev is for correctness testing, not dashboards |
| No alarms | Threshold breaches are not detected locally | Document the gap — alarms require CloudWatch infrastructure |
| No dashboards | Cannot preview dashboard visualizations locally | Document the gap — dashboards are a CloudWatch console feature |
| No namespace-scoped IAM | Permission errors only surface in AWS | IAM is handled by CDK grants automatically |
| No log retention limits | Stdout grows unbounded in local dev | Terminal scrollback is the natural limit |

## Validation

Validation covers these CloudWatch constraints:
- **Metric name:** Non-empty, max 1024 characters, not `_aws`, and not equal to one of its own dimension keys (both are top-level keys in the EMF document)
- **Dimensions:** Max 30 key-value pairs, non-empty keys and values, max 1024 chars each, no `_aws` key
- **Unit:** One of the `MetricUnit` values, which are the units the EMF schema accepts
- **Batch size:** Max 100 metrics per `emitBatch` call (EMF document limit)

Validation runs synchronously before the stdout write. Failures throw typed errors (`MetricsErrors.*`) that can be caught with `isBlocksError()`.

The EMF specification is stricter than the limits above: metric names are limited to 255 characters, dimension keys to 250 characters and must not start with `:`, and both must be printable ASCII. Names and keys that pass validation here but break those rules are dropped by CloudWatch without an error. These limits are not enforced yet, because tightening them would make inputs that are accepted today start throwing.

Values and timestamps come from runtime data rather than code, so they are not thrown on. A value that is not a finite number (`NaN` and `Infinity` serialize as `null`) or a timestamp that is not a valid `Date` (also `null`) leaves that data point out of the document with a warning through the configured logger. Its siblings in the batch are still written. A ratio such as `errors / total` is `NaN` at zero traffic, and a metrics call should not fail the request it observes.

Metric values are written with `Object.defineProperty`, so a metric named `__proto__` gets its own key instead of calling the prototype setter.
