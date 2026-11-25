---
"@aws-cdk-blocks/bb-realtime": patch
"aws-cdk-blocks": patch
---

Server-side `Realtime` subscribers in the same process now each receive their own copy of a published message, in the JSON form a WebSocket delivers. Before, the local mock (and, on AWS, same-process delivery before a subscriber's socket was live) handed every handler the publisher's object, so a handler that mutated its message changed it for the next handler and for the publisher, and values such as a `Date` arrived unconverted.
