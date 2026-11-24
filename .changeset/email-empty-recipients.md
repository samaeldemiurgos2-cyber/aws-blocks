---
"@aws-cdk-blocks/bb-email-client": patch
"aws-cdk-blocks": patch
---

EmailClient: `send()` and `sendBatch()` now reject a message with no recipients (To, CC and BCC all empty or absent) with `InvalidInputException`, on the local mock and before calling SES on AWS. Previously the mock returned a message ID for `send({ to: [] })` while SES rejects it.
