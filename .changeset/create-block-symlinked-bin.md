---
"@aws-cdk-blocks/create-block": patch
---

`npm create @aws-cdk-blocks/block@latest <ClassName>` and `npx @aws-cdk-blocks/create-block <ClassName>` now scaffold the Building Block. In 1.0.0 these commands exited with code 0, printed nothing and created no files, because the scaffolder did not start when npm ran it through the `node_modules/.bin/create-block` symlink. The scaffolder also starts now when a directory in its install path is a symlink.
