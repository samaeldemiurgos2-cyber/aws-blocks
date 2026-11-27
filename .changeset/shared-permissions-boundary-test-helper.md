---
'@aws-cdk-blocks/core': patch
'@aws-cdk-blocks/bb-auth': patch
'@aws-cdk-blocks/bb-compute': patch
'@aws-cdk-blocks/bb-container-compute': patch
'@aws-cdk-blocks/bb-cron-job': patch
'@aws-cdk-blocks/bb-dashboard': patch
'aws-cdk-blocks': patch
---

The test helper that checks every IAM role carries `defaults.permissionsBoundary` and is listed in the IAM report now has one definition in `@aws-cdk-blocks/core` instead of a copy in five packages' tests. Behaviour is unchanged.
