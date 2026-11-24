---
"@aws-cdk-blocks/core": patch
---

The local dev server now matches the deployed API's status codes in two cases. A RawRoute or JSON-RPC request whose path holds a `%` not followed by two hex digits (such as `/users/%E0%A4%A` or `/users/100%`) gets a 400, as API Gateway answers it, instead of reaching the handler with the undecoded text as its parameter. The body is `{"error":"Bad Request"}`, following the dispatcher's error shape, where API Gateway sends an empty body. A request that matches no route, when no frontend dev server is running, gets the deployed dispatcher's 404 `{"error":"Not Found"}` with `Content-Type: application/json` instead of an empty body.
