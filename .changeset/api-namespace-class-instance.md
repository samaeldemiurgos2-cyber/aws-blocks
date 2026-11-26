---
"@aws-cdk-blocks/core": patch
"aws-cdk-blocks": patch
---

`ApiNamespace` now type-checks a handler that returns a class instance, such as `new ApiNamespace(scope, 'calc', () => new Calculator())`, which the runtime already dispatched.
