---
'@aws-cdk-blocks/bb-auth': patch
'aws-cdk-blocks': patch
---

`Auth` reports `@aws-cdk-blocks/bb-auth:RemovalPolicyUnset` only when the user pool would be deleted outside a sandbox: `removalPolicy` is unset, the stack default is `RemovalPolicy.DESTROY`, and the deployment is not a sandbox. Before, every `Auth` without `removalPolicy` got the warning on every synth, including under `BlocksPresets.production`, which retains the pool, and in a sandbox, where the pool is meant to be deleted.
