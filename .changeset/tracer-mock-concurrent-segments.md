---
"@aws-cdk-blocks/bb-tracer": patch
"aws-cdk-blocks": patch
---

The local `Tracer` mock now keeps overlapping top-level `startSegment` calls, such as concurrent dev-server requests, in separate traces. Each keeps its own trace ID, root annotations, root metadata and child segments, and nested segments, including ones run in parallel, attach to the parent in their own async chain. When a segment's function throws a value that is not an `Error`, such as `undefined`, `null` or a string, the local mock now rethrows that value unchanged instead of a `TypeError`, as the AWS runtime does. The recorded segment error follows X-Ray: a string is recorded as the message, and `undefined`, `null` and other non-object values record no error.
