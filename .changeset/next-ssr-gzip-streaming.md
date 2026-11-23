---
'@aws-cdk-blocks/hosting': patch
'aws-cdk-blocks': patch
---

Next.js on Lambda now gzips its streamed server responses for clients that accept gzip, behind the CloudFront door and behind `apiGateway` with `api: 'rest'`. Before, the server sent them with `content-encoding: identity` and no `Content-Length`, so CloudFront could not compress them and every page's HTML reached the browser uncompressed. A compressed response drops the page's uncompressed `Content-Length`, every response from the wrapper carries `Vary: Accept-Encoding`, and a client that refuses gzip with `q=0` gets an uncompressed body. The README now also states that the ALB and API Gateway doors otherwise compress static files only, how an app can compress its own server responses there, and that Next.js on Lambda is the exception (its wrapper sets `Content-Encoding` itself).
