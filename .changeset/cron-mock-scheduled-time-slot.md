---
"@aws-cdk-blocks/bb-cron-job": patch
"aws-cdk-blocks": patch
---

The CronJob local mock now sets `scheduledTime` to the schedule slot, formatted to whole seconds (for example `2026-03-01T00:10:00Z`), as EventBridge Scheduler does. It used to report the moment the local timer ran, with milliseconds.
