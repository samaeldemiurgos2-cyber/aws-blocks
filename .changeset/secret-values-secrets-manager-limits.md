---
"@aws-cdk-blocks/bb-secret": patch
"@aws-cdk-blocks/bb-app-setting": patch
"aws-cdk-blocks": patch
---

`Secret.put()` now rejects an empty, non-string or over-65,536-byte value with `SecretErrors.ValidationFailed` and `Secret.get()` returns `null` for a version id Secrets Manager cannot accept, both locally and on AWS, and `AppSetting.put('')` on a `secret: true` setting, which used to succeed and leave every later `get()` failing, now throws `AppSettingErrors.ValidationFailed` on write.
