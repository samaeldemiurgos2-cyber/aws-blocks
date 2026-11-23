---
'@aws-cdk-blocks/hosting': patch
'@aws-cdk-blocks/core': patch
---

Behind the ALB and API Gateway front doors, which have no edge cache, synth now warns once per app (`@aws-cdk-blocks/hosting:NoEdgeCache`) when the app's header rules set a `Cache-Control` that asks a shared cache to store the response (`s-maxage` above zero, or `stale-while-revalidate` / `stale-if-error` on a `public` or `s-maxage` response, and neither `private` nor `no-store`; the Nitro adapter emits these for `swr` and `cache.maxAge` route rules). The warning names the routes (the first five, then a count) and points to the CloudFront and stacked doors, which cache at the edge. On these doors no shared cache stores such routes, so each visitor's requests reach the server (the browser's own cache still applies to `max-age`) and the header goes to the browser unchanged. The READMEs now say what caching still happens there per framework (Nitro's server-side cache, Next.js ISR through OpenNext's incremental cache unless `incrementalRegeneration: false`, none for Astro and SvelteKit), and that moving an app from the CloudFront door to one of these doors loses the edge cache.
