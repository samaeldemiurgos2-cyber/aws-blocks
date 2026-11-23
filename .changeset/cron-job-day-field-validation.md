---
'@aws-cdk-blocks/bb-cron-job': patch
'aws-cdk-blocks': patch
---

Reject CronJob schedules that EventBridge Scheduler would reject at deploy, in local dev and at synth instead of minutes into `cdk deploy`. A cron expression must set exactly one of day-of-month and day-of-week to `?`, so `cron(0 12 * * MON *)` and `cron(0 0 ? * ? *)` now throw `CronJobErrors.InvalidSchedule`. A day-of-month that no listed month has, such as `cron(0 0 30 2 ? *)`, now throws `CronJobErrors.InvalidSchedule` instead of logging a warning in the local mock. The local mock now throws `CronJobErrors.InvalidTimezone` for `timezone: ''`, as synth already did. A CronJob constructed in the AWS runtime now runs the same schedule and timezone checks as synth, so it rejects the same inputs as the local mock.
