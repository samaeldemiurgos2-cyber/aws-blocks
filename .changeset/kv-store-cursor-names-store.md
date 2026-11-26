---
"@aws-cdk-blocks/bb-kv-store": patch
"aws-cdk-blocks": patch
---

`KVStore` cursors now carry a tag of the store that issued them, so `query()` and `scan()` reject a cursor from another store with the same key shape with `InvalidQueryException`, while cursors issued by 1.0.0 are still accepted.
