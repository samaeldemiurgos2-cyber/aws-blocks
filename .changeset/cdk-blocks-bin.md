---
"aws-cdk-blocks": patch
"@aws-cdk-blocks/create-blocks-app": patch
---

New apps get short task scripts, such as `"dev": "cdk-blocks dev"`. The scripts call the `cdk-blocks` bin that `aws-cdk-blocks` now installs. Run the tasks with `npm run <task>`, as before. Scripts in the 1.0.0 form, `node --input-type=module -e "import 'aws-cdk-blocks/run'" -- <task>`, keep working. `npm run migrate` shortens each generated one to `cdk-blocks <task>`.

When you add AWS CDK Blocks to a project that already depends on `aws-cdk-blocks` with another range, `create-blocks-app` keeps your range and prints a warning: the added scripts call the `cdk-blocks` bin, and `aws-cdk-blocks` 1.0.0 does not have it.
