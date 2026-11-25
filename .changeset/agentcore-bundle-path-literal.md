---
"@aws-cdk-blocks/bb-agent": patch
---

The AgentCore co-bundle now also escapes `<`, `>`, `/` and the U+2028/U+2029 line separators when it writes the backend module path into the generated entry source.
