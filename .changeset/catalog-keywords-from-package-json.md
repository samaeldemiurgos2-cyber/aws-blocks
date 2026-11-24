---
"aws-cdk-blocks": patch
"@aws-cdk-blocks/admin-ui": patch
"@aws-cdk-blocks/auth-common": patch
"@aws-cdk-blocks/bb-agent": patch
"@aws-cdk-blocks/bb-app-setting": patch
"@aws-cdk-blocks/bb-async-job": patch
"@aws-cdk-blocks/bb-auth": patch
"@aws-cdk-blocks/bb-compute": patch
"@aws-cdk-blocks/bb-container-compute": patch
"@aws-cdk-blocks/bb-cron-job": patch
"@aws-cdk-blocks/bb-dashboard": patch
"@aws-cdk-blocks/bb-database": patch
"@aws-cdk-blocks/bb-email-client": patch
"@aws-cdk-blocks/bb-file-bucket": patch
"@aws-cdk-blocks/bb-knowledge-base": patch
"@aws-cdk-blocks/bb-kv-store": patch
"@aws-cdk-blocks/bb-lambda-compute": patch
"@aws-cdk-blocks/bb-logger": patch
"@aws-cdk-blocks/bb-metrics": patch
"@aws-cdk-blocks/bb-realtime": patch
"@aws-cdk-blocks/bb-secret": patch
"@aws-cdk-blocks/bb-tracer": patch
"@aws-cdk-blocks/core": patch
"@aws-cdk-blocks/create-block": patch
"@aws-cdk-blocks/create-blocks-app": patch
"@aws-cdk-blocks/hosting": patch
"@aws-cdk-blocks/pipeline": patch
---

The npm discovery keyword is now `cdk-blocks`. Every published package carries it in place of `aws-blocks`, so find them with `npm search keywords:cdk-blocks`. If you publish your own Building Block, tag it `cdk-blocks` to be listed with them. `@aws-cdk-blocks/create-block` scaffolds the new keyword, and in every mode, not only outside the monorepo.

The Building Block catalog in the `aws-cdk-blocks` README lists keywords for every block. They come from the `keywords` of each package's `package.json`, without the `cdk-blocks` tag that every package carries. Before, the catalog read a `**Keywords:**` line in each README, which only `bb-async-job` and `bb-cron-job` had, so the other 19 rows were blank.

The `bb-async-job` and `bb-cron-job` READMEs no longer have that line. Its terms moved to the `keywords` of each package, so `npm search` finds them too: for example `worker`, `retry` and `batch` for `bb-async-job`, and `schedule`, `periodic` and `recurring` for `bb-cron-job`.

The README template of `@aws-cdk-blocks/create-block` no longer has a `**Keywords:**` line, and the next steps printed for a block scaffolded in this repository say to add keywords to its `package.json`.
