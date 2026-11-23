---
'@aws-cdk-blocks/hosting': patch
'aws-cdk-blocks': patch
---

Astro server builds now route the files copied from `public/` (such as `robots.txt`, favicons and downloads) to the assets bucket, like Nuxt and SvelteKit builds already do. Every front door serves them as static files instead of sending them to the Astro server, so the stacked door's CloudFront edge caches them and they skip the ALB router's 1 MB response limit. A `public/` folder is routed as a whole only when no page can render under it: no same-named page or folder in `src/pages`, no route an integration injects under it, and no top-level dynamic page. Otherwise it stays with the server. When the stacked door's edge is over its behavior budget, single-file static routes now give way before static prefixes, so hashed bundles such as `/_astro/*` keep their S3 behavior.
