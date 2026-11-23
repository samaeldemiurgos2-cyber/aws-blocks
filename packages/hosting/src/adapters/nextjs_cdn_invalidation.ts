// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenNext `cdnInvalidation` override that propagates Next.js on-demand
 * revalidation (`revalidateTag`, `revalidatePath`, `res.revalidate`) to the
 * CloudFront front door.
 *
 * OpenNext answers ISR pages with `s-maxage=<remaining revalidate>` and the
 * SSR cache policy honours it, so without an invalidation the edge keeps
 * serving the old page for the rest of that window even though the origin
 * has regenerated it.
 *
 * The generated `open-next.config.ts` imports this module (by absolute path)
 * as the default function's `cdnInvalidation` override. It runs inside the
 * server Lambda and needs two things from the Hosting construct, both
 * injected only for the CloudFront door:
 *
 * - `HOSTING_CDN_INVALIDATION_PARAM` — the name of an SSM parameter holding
 *   the distribution id. The id can't be put in the function's environment
 *   directly: the distribution's origin depends on the function, so the
 *   reverse reference would be a dependency cycle.
 * - `cloudfront:CreateInvalidation` on that one distribution, plus
 *   `ssm:GetParameter` on that one parameter.
 *
 * Without `HOSTING_CDN_INVALIDATION_PARAM` (another front door, local runs)
 * every call is a no-op.
 *
 * Runtime code: no CDK imports.
 *
 * @module
 */

import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

import {
	CDN_INVALIDATION_BASE_PATH_ENV,
	CDN_INVALIDATION_HANDLER_NAME,
	CDN_INVALIDATION_PARAM_ENV,
} from './shared/cdn_invalidation_env.js';

export { CDN_INVALIDATION_BASE_PATH_ENV, CDN_INVALIDATION_HANDLER_NAME, CDN_INVALIDATION_PARAM_ENV };

/**
 * Above this many wildcard paths in one revalidation, a single `/*`
 * (`<basePath>*`) invalidation is issued instead. CloudFront allows at most 15
 * wildcard paths in progress per account at once (the "File invalidation:
 * maximum number of active wildcard invalidations allowed" quota, not
 * adjustable) and rejects a request past it with
 * `TooManyInvalidationsInProgress`. Every page path is a wildcard (see
 * `wildcardPath`); only the exact root paths don't count.
 */
export const MAX_WILDCARD_PATHS = 15;

/** OpenNext's soft (implicit, path-derived) tag prefix. */
const SOFT_TAG_PREFIX = '_N_T_/';

/** Route-scoped cache keys (Next 15.5.27+ / 16.3.8+): `route-cache/<KIND>/<sha256>/$/<path>`. */
const ROUTE_CACHE_KEY = /^\/?route-cache\/(PAGES|APP_PAGE|APP_ROUTE)\/[0-9a-f]{64}\/\$(\/.*)$/;

/** A fetch / `unstable_cache` entry key: never a CDN path. */
const DATA_CACHE_KEY = /^[0-9a-f]{64}$/;

/**
 * A path-style page key of older Next releases (`blog/hello`, `index`): no
 * whitespace, quotes, brackets, braces or commas. A `'use cache'` (composable cache) key is Next's
 * serialised `[id, args, …]` (brackets, quotes, commas between them) and
 * never matches, so it is not mistaken for a page.
 */
const PATH_STYLE_KEY = /^[^\s"'[\]{},\\<>^`|]+$/u;

/** RFC 1738 unsafe characters, which CloudFront wants percent-encoded in an invalidation path. */
const RFC1738_UNSAFE = new Set([' ', '<', '>', '"', '#', '%', '{', '}', '|', '\\', '^', '[', ']', '`']);

/** A path OpenNext hands to `invalidatePaths` (a subset of its `CDNPath`). */
export interface CdnPath {
	initialPath: string;
	rawPath?: string;
	resolvedRoutes: ReadonlyArray<{ route?: string; type: string }>;
}

/** The parts of OpenNext's tag cache this handler reads (both tag cache modes). */
export interface TagCacheLike {
	getByTag?: (tag: string) => Promise<string[]>;
	getPathsByTags?: (tags: string[]) => Promise<string[]>;
}

/** The shape OpenNext expects from a `cdnInvalidation` override. */
export interface CdnInvalidationHandler {
	name: string;
	invalidatePaths: (paths: CdnPath[]) => Promise<void>;
	invalidateTags: (tags: string[]) => Promise<void>;
}

/** Collaborators, injectable for tests. */
export interface CdnInvalidationDeps {
	/** Issue one invalidation of `paths` on `distributionId`. */
	createInvalidation?: (distributionId: string, paths: string[]) => Promise<void>;
	/** Read the distribution id from the named SSM parameter. */
	readDistributionId?: (parameterName: string) => Promise<string>;
	/** The tag cache. @default globalThis.tagCache (set by OpenNext) */
	tagCache?: () => TagCacheLike | undefined;
	/** Environment. @default process.env */
	env?: NodeJS.ProcessEnv;
}

/** A page path the CDN caches, and whether it is a Pages Router page. */
interface PagePath {
	path: string;
	pagesRouter: boolean;
}

/** Mirrors Next's `denormalizePagePath`: `/index` → `/`, `/index/index/x` → `/index/x`. */
function denormalizePagePath(page: string): string {
	if (page.startsWith('/index/') && !/\/\[[^/]+?\](?=\/|$)/.test(page)) return page.slice(6);
	return page === '/index' ? '/' : page;
}

/**
 * The page path a tag-cache key stands for, or `undefined` for a data-cache
 * (fetch / `unstable_cache`) key or a `'use cache'` (composable cache) key,
 * which the CDN never caches.
 *
 * @param key a key from the tag cache, without the build id
 * @returns the page path, or `undefined`
 */
export function cacheKeyToPagePath(key: string): PagePath | undefined {
	const route = ROUTE_CACHE_KEY.exec(key);
	if (route) return { path: denormalizePagePath(route[2]), pagesRouter: route[1] === 'PAGES' };
	if (DATA_CACHE_KEY.test(key) || !PATH_STYLE_KEY.test(key)) return undefined;
	// Older Next releases key a page by its path (`blog/hello`, `index`).
	return { path: denormalizePagePath(key.startsWith('/') ? key : `/${key}`), pagesRouter: false };
}

/**
 * The page path a soft tag names directly (`_N_T_/blog/hello` → `/blog/hello`),
 * so `revalidatePath()` reaches a page the tag cache has no row for. Tags for a
 * layout, a `page` / `route` segment or a dynamic pattern name no single URL and
 * return `undefined`; their pages are found through the tag cache.
 */
function softTagPath(tag: string): string | undefined {
	if (!tag.startsWith(SOFT_TAG_PREFIX)) return undefined;
	const path = `/${tag.slice(SOFT_TAG_PREFIX.length)}`.replace(/\/+$/, '') || '/';
	if (/\/(layout|page|route)$/.test(path) || path === '/layout' || path.includes('[')) return undefined;
	// Next 16 tags the root page as both `_N_T_/` and `_N_T_/index`.
	return denormalizePagePath(path);
}

/**
 * Percent-encode what CloudFront needs encoded in an invalidation path: non-ASCII
 * characters and the RFC 1738 unsafe ones. Every other character is left as is
 * (`/blog/@alice`, `/tags/c++`): CloudFront doesn't invalidate a path whose
 * safe characters are encoded.
 */
function encodePath(path: string): string {
	return path
		.split('/')
		.map((segment) => {
			let out = '';
			for (const char of decodeSafely(segment)) {
				const code = char.codePointAt(0) ?? 0;
				out += code <= 0x20 || code >= 0x7f || RFC1738_UNSAFE.has(char) ? encodeURIComponent(char) : char;
			}
			return out;
		})
		.join('/');
}

/**
 * The invalidation path covering every cached variant of one page URL: a
 * trailing `*` matches the query-string variants (the SSR cache policy keys on
 * the query string) and the trailing-slash form (`trailingSlash: true`), and
 * stays one billed path. It also matches other URLs that start with the same
 * characters (`/blog*` takes `/blog/hello` and `/blogroll` too), which only
 * costs those pages one extra origin request.
 *
 * CloudFront doesn't support `~` in an invalidation path, so a path with one is
 * cut back to the wildcard before it.
 */
function wildcardPath(path: string): string {
	const encoded = encodePath(path);
	const tilde = encoded.indexOf('~');
	return `${tilde === -1 ? encoded : encoded.slice(0, tilde)}*`;
}

function decodeSafely(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

/**
 * Turn page paths into CloudFront invalidation paths: the `basePath` prefix,
 * the Pages Router data route next to a Pages Router page, deduplicated, and
 * collapsed to a single `/*` (`<basePath>*` with a `basePath`) past
 * {@link MAX_WILDCARD_PATHS} wildcard paths.
 *
 * Each page path ends in `*` (see `wildcardPath`), so it covers the page's
 * query-string variants and its trailing-slash form. The same path covers the
 * HTML and the RSC payload: the SSR cache policy keys RSC requests on the
 * `rsc` header and leaves `_rsc` out of the cache key, and an invalidation
 * drops every header variant of a path. The root page is the exception: a
 * `/*` there would purge the whole distribution, so it gets the exact `/`
 * (`<basePath>` and `<basePath>/` with a `basePath`), and its query-string
 * variants keep their cached copy until their `s-maxage` runs out.
 *
 * @param pages the pages to invalidate, relative to the `basePath`
 * @param options.basePath the app's Next.js `basePath`, if any
 * @param options.buildId Next's build id (`NEXT_BUILD_ID`), for Pages Router data routes
 * @returns the invalidation paths (empty when there is nothing to invalidate)
 */
export function toInvalidationPaths(
	pages: ReadonlyArray<PagePath>,
	options: { basePath?: string; buildId?: string } = {},
): string[] {
	const base = (options.basePath ?? '').replace(/\/+$/, '');
	const out = new Set<string>();
	for (const { path, pagesRouter } of pages) {
		const clean = path.startsWith('/') ? path.replace(/(.)\/+$/, '$1') : `/${path}`;
		if (clean === '/') {
			if (base) {
				out.add(encodePath(base));
				out.add(`${encodePath(base)}/`);
			} else {
				out.add('/');
			}
		} else {
			out.add(wildcardPath(`${base}${clean}`));
		}
		if (pagesRouter && options.buildId) {
			// Next adds the dynamic route's params as a query string to a data URL.
			out.add(wildcardPath(`${base}/_next/data/${options.buildId}${clean === '/' ? '/index' : clean}.json`));
		}
	}
	if (out.size === 0) return [];
	if ([...out].filter((p) => p.endsWith('*')).length > MAX_WILDCARD_PATHS) return [broadestPath(base)];
	return [...out];
}

/** The one wildcard path covering every page of the app: `/*`, or `<basePath>*`. */
function broadestPath(base: string): string {
	return base ? `${encodePath(base)}*` : '/*';
}

/** Whether CloudFront rejected an invalidation for its in-progress quota. */
function isTooManyInvalidations(e: unknown): boolean {
	return e instanceof Error && e.name === 'TooManyInvalidationsInProgress';
}

/**
 * A path relative to the `basePath`. OpenNext passes `invalidatePaths` the
 * request or `res.revalidate()` path, which may carry the `basePath`, while the
 * paths derived from tags never do.
 */
function stripBasePath(path: string, base: string): string {
	if (!base) return path;
	if (path === base) return '/';
	return path.startsWith(`${base}/`) ? path.slice(base.length) : path;
}

function defaultCreateInvalidation(): (distributionId: string, paths: string[]) => Promise<void> {
	let client: CloudFrontClient | undefined;
	return async (distributionId, paths) => {
		client ??= new CloudFrontClient({});
		await client.send(
			new CreateInvalidationCommand({
				DistributionId: distributionId,
				InvalidationBatch: {
					Paths: { Quantity: paths.length, Items: paths },
					CallerReference: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
				},
			}),
		);
	};
}

function defaultReadDistributionId(): (parameterName: string) => Promise<string> {
	let client: SSMClient | undefined;
	return async (parameterName) => {
		client ??= new SSMClient({});
		const out = await client.send(new GetParameterCommand({ Name: parameterName }));
		const value = out.Parameter?.Value;
		if (!value) throw new Error(`SSM parameter ${parameterName} has no value.`);
		return value;
	};
}

/**
 * Create the `cdnInvalidation` handler.
 *
 * @param deps collaborators to replace (tests); the defaults call AWS.
 * @returns the handler OpenNext calls after a revalidation.
 */
export function createCdnInvalidationHandler(deps: CdnInvalidationDeps = {}): CdnInvalidationHandler {
	const env = deps.env ?? process.env;
	const createInvalidation = deps.createInvalidation ?? defaultCreateInvalidation();
	const readDistributionId = deps.readDistributionId ?? defaultReadDistributionId();
	const tagCache = deps.tagCache ?? (() => (globalThis as { tagCache?: TagCacheLike }).tagCache);
	let distributionId: Promise<string> | undefined;

	const invalidate = async (pages: PagePath[]): Promise<void> => {
		const parameterName = env[CDN_INVALIDATION_PARAM_ENV];
		if (!parameterName) return;
		const paths = toInvalidationPaths(pages, {
			basePath: env[CDN_INVALIDATION_BASE_PATH_ENV],
			// `/_next/data/<id>/…` URLs carry Next's build id; `OPEN_NEXT_BUILD_ID`
			// is the `deploymentId` when one is set (a storage key, not a URL part).
			buildId: env.NEXT_BUILD_ID ?? env.OPEN_NEXT_BUILD_ID,
		});
		if (paths.length === 0) return;
		distributionId ??= readDistributionId(parameterName).catch((e: unknown) => {
			// Retry the lookup on the next revalidation instead of caching the failure.
			distributionId = undefined;
			throw e;
		});
		const id = await distributionId;
		try {
			await createInvalidation(id, paths);
		} catch (e) {
			// Past CloudFront's in-progress quota (another revalidation's wildcard
			// paths still running): one `/*` needs a single slot. A single path
			// already needs only one, so it isn't retried.
			if (!isTooManyInvalidations(e) || paths.length <= 1) throw e;
			await createInvalidation(id, [
				broadestPath((env[CDN_INVALIDATION_BASE_PATH_ENV] ?? '').replace(/\/+$/, '')),
			]);
		}
	};

	return {
		name: CDN_INVALIDATION_HANDLER_NAME,
		async invalidatePaths(paths) {
			const base = (env[CDN_INVALIDATION_BASE_PATH_ENV] ?? '').replace(/\/+$/, '');
			await invalidate(
				paths.map(({ initialPath, resolvedRoutes }) => ({
					path: stripBasePath(initialPath.startsWith('/') ? initialPath : `/${initialPath}`, base),
					pagesRouter: resolvedRoutes.length > 0 && !resolvedRoutes.some((r) => r.type === 'app'),
				})),
			);
		},
		// OpenNext calls this (instead of `invalidatePaths`) after `revalidateTag`
		// and `revalidatePath`. Its own tag→path mapping only follows soft tags, so a
		// page tagged through `fetch` / `unstable_cache` would never be purged;
		// resolve every tag to the pages that carry it here instead.
		async invalidateTags(tags) {
			if (!env[CDN_INVALIDATION_PARAM_ENV] || tags.length === 0) return;
			const cache = tagCache();
			let keys: string[] = [];
			if (cache?.getPathsByTags) {
				keys = await cache.getPathsByTags(tags);
			} else if (cache?.getByTag) {
				const getByTag = cache.getByTag.bind(cache);
				keys = (await Promise.all(tags.map((tag) => getByTag(tag)))).flat();
			}
			const pages: PagePath[] = [];
			for (const key of keys) {
				const page = cacheKeyToPagePath(key);
				if (page) pages.push(page);
			}
			for (const tag of tags) {
				const path = softTagPath(tag);
				if (path) pages.push({ path, pagesRouter: false });
			}
			await invalidate(pages);
		},
	};
}

/** The handler the generated `open-next.config.ts` installs. */
const handler: CdnInvalidationHandler = createCdnInvalidationHandler();
export default handler;
