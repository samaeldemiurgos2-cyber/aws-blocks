---
"@aws-cdk-blocks/bb-database": patch
"aws-cdk-blocks": patch
---

`Database` migration files now run with the numbers in their names compared by value, so `1_create.sql`, `2_add_a.sql` and `10_add_b.sql` run in that order instead of `10_add_b.sql` first, locally and on AWS.
