---
"@aws-cdk-blocks/bb-async-job": patch
"aws-cdk-blocks": patch
---

`AsyncJob.submit()` and `submitBatch()` now throw `AsyncJobErrors.ValidationFailed`, in local dev and on AWS, for a payload that cannot be encoded as JSON (`undefined`, a function, a symbol, a bigint anywhere in the value, or a circular reference) instead of a raw `TypeError` that reached the client as an unnamed 500 error, and the local mock now passes the handler the payload's JSON form, as AWS does, rather than the submitted object.
