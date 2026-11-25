---
"@aws-cdk-blocks/bb-app-setting": patch
"aws-cdk-blocks": patch
---

`AppSetting.put()` now throws `AppSettingErrors.ValidationFailed` for a value with no JSON representation (`undefined`, a function, a symbol, a bigint or a circular object) instead of a raw `TypeError` or SSM `ValidationException`, or, locally on a secret setting, silently storing nothing.
