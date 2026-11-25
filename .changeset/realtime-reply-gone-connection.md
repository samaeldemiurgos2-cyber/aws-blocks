---
'@aws-cdk-blocks/bb-realtime': patch
---

The Realtime WebSocket handler now ignores a `GoneException` when it replies to a subscribe from a client that has already disconnected, instead of failing the invocation and logging the SDK error.
