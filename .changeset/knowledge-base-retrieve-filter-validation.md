---
"@aws-cdk-blocks/bb-knowledge-base": patch
"aws-cdk-blocks": patch
---

`KnowledgeBase.retrieve()` now checks its `filter` before searching, in local development and on AWS, and rejects a filter that would not narrow the search with `KnowledgeBaseValidationError`. That covers `filter: null`, `filter: {}`, a key without a condition object, an operator other than `equals`, and an `equals` that is missing, not a string, or empty. Before, `null` and `{}` ran an unfiltered search on both runtimes, the local mock matched a condition without `equals` against every document that lacked the key, and AWS sent that condition to Bedrock without a value. Omitting `filter` (or passing `undefined`) still searches the whole knowledge base. Code that passed `filter: {}` or an `equals: ''` condition was previously accepted and now throws; omit `filter` to search everything. `asAgentTool()` uses the same check.
