---
"@aws-cdk-blocks/bb-kv-store": patch
"aws-cdk-blocks": patch
---

`KVStore` now throws a named `ValidationFailedException`, on the mock and on AWS, for a value, number key, condition operand or `ttlSeconds` that the AWS SDK cannot send to DynamoDB (such as `NaN`, `Infinity`, a `Date`, a symbol or a number outside the safe integer range), where AWS previously returned a 500 with no error name, and the mock now also rejects such a number key or query operand on `get`, `delete` and `query`, which it previously accepted.
