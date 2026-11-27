---
'@aws-cdk-blocks/bb-database': patch
'aws-cdk-blocks': patch
---

The tests of how `Database.transaction()` routes statements now run only against a real PostgreSQL server; the ones that asserted recorded engine calls are removed. Behaviour is unchanged.
