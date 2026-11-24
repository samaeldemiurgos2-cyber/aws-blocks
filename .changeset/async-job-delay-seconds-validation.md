---
"@aws-cdk-blocks/bb-async-job": patch
"aws-cdk-blocks": patch
---

`AsyncJob.submit()` and `submitBatch()` now check `delaySeconds` before queueing anything. A value that is not an integer from 0 to 900 throws `AsyncJobErrors.ValidationFailed`, which keeps its name across the RPC boundary. Before, the local mock ran a negative delay immediately and accepted delays above 900 seconds, while on AWS the SQS rejection reached the client as an unnamed 500 error, or from `submitBatch()` as `BatchSubmitFailed`.
