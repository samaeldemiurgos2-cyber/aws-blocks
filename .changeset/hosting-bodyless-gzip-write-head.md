---
"@aws-cdk-blocks/hosting": patch
"aws-cdk-blocks": patch
---

Next.js on Lambda no longer gzips a response that has no body. A `HEAD` request, or a `1xx`, `204`, `205` or `304` response, requested with `Accept-Encoding: gzip`, was sent with `content-encoding: gzip`, a 20-byte empty gzip body and, for `HEAD`, without its `Content-Length`. It is now sent uncompressed, with its headers as the app set them. The SSR cache guard on Node.js servers now reads the headers of `res.writeHead(status, undefined, headers)` and `res.writeHead(status, null, headers)`, which it skipped before, and no longer makes Node reject a `writeHead` call that passes its headers as an array of `[name, value]` pairs when the guard rewrites `Cache-Control`.
