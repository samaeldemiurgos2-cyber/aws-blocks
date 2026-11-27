---
"@aws-cdk-blocks/bb-auth": patch
"aws-cdk-blocks": patch
---

Removed an unused internal method of the `Auth` session store that replaced a session without checking that it was unchanged. Nothing called it, so behaviour is unchanged.
