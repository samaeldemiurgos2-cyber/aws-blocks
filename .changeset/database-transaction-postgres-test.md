---
'@aws-cdk-blocks/bb-database': patch
'aws-cdk-blocks': patch
---

`Database.transaction()` is now also tested against a real PostgreSQL server with several pooled connections: a statement issued on the block inside the callback runs in that transaction and is rolled back with it. Behaviour is unchanged.
