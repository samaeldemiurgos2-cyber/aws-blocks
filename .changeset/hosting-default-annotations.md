---
'@aws-cdk-blocks/hosting': patch
'aws-cdk-blocks': patch
---

An app that uses `Hosting` with its defaults no longer gets three warnings on every `cdk synth`, `cdk deploy` and `cdk explore`, so `cdk synth --strict` passes on it. No synthesized template changes.

- `@aws-cdk-blocks/hosting:MonitoringAlarmTopicHasNoSubscribers` (the alarm topic has no subscriber) is now an info. `cdk synth` still prints it until the topic is subscribed. To hide it, call `acknowledgeInfo(id)` on the stack that owns the topic; an existing `acknowledgeWarning(id)` call there keeps working.
- `@aws-cdk-blocks/hosting:CloudFrontAlarmRegionUnresolved` (a stack without `env` creates the CloudFront 5xx alarm in its own region) is an info when the CDK CLI deploys the stack to us-east-1, where the alarm works; hide that one with `acknowledgeInfo(id)`. For any other region it stays a warning, and now names the region.
- Hosting sets `minimumProtocolVersion` on the CloudFront distribution only with a custom certificate. CloudFront ignores the setting without one, and aws-cdk-lib 2.264.0 and later warn about it (`@aws-cdk/aws-cloudfront:minimumProtocolVersionWithoutCertificate`).
