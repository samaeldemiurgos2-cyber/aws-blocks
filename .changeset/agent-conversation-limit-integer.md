---
"@aws-cdk-blocks/bb-agent": patch
"aws-cdk-blocks": patch
---

`Agent.getConversation()` now throws `AgentErrors.InvalidUsage` for a `limit` that isn't an integer, where `1.5` used to return 2 messages and `NaN` or `Infinity` returned the whole history.
