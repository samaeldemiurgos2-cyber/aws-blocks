---
"@aws-cdk-blocks/bb-auth": patch
"aws-cdk-blocks": patch
---

The local user pool now refuses usernames and passwords that Cognito refuses (an empty username, one over 128 characters or containing whitespace or control characters, and a password over 256 characters) with `InvalidParameterException` before storing anything.
