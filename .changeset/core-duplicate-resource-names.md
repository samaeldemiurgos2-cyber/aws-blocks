---
"@aws-cdk-blocks/core": patch
"aws-cdk-blocks": patch
---

`cdk synth` now fails, naming both construct paths, when two resources in a backend get the same table, queue, schedule, bucket, secret, parameter, log group or Lambda function name, such as two blocks under scope paths `'a-b' > 'x'` and `'a' > 'b' > 'x'`, instead of synthesizing a stack that CloudFormation rejects at deploy.
