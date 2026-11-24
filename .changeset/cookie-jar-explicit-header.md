---
"aws-cdk-blocks": patch
---

`installCookieJar()` from `aws-cdk-blocks/utils` no longer replaces a `Cookie` header the caller set. A request with its own `Cookie` header (in `init.headers` or on a `Request`) is sent with that header unchanged, and a `Request` passed without `init` keeps its other headers when the jar adds its cookies.
