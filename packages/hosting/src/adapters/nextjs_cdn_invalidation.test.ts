// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { nextjsAdapter } from './nextjs.js';
import {
	CDN_INVALIDATION_BASE_PATH_ENV,
	CDN_INVALIDATION_HANDLER_NAME,
	CDN_INVALIDATION_PARAM_ENV,
	MAX_WILDCARD_PATHS,
	cacheKeyToPagePath,
	createCdnInvalidationHandler,
	toInvalidationPaths,
} from './nextjs_cdn_invalidation.js';
import { withBuildProfile } from './shared/build_profile.js';
import { CDN_INVALIDATION_BUNDLE_FILE } from './shared/cdn_invalidation_env.js';
import { spawn } from './spawn.js';

const HASH = 'a'.repeat(64);
type InvalidateTags = (tags: string[]) => Promise<void>;
const PAGE_KEY = `route-cache/APP_PAGE/${'3'.repeat(64)}/$/isr-tag`;

/** A handler wired to fakes, recording every invalidation it issues. */
const fakeHandler = (opts: { env?: NodeJS.ProcessEnv; byTag?: Record<string, string[]> } = {}) => {
	const calls: Array<{ distributionId: string; paths: string[] }> = [];
	const lookups: string[] = [];
	const handler = createCdnInvalidationHandler({
		env: opts.env ?? { [CDN_INVALIDATION_PARAM_ENV]: '/cdk-blocks/hosting/App/x/distribution-id' },
		createInvalidation: async (distributionId, paths) => {
			calls.push({ distributionId, paths });
		},
		readDistributionId: async (name) => {
			lookups.push(name);
			return 'E2EXAMPLE123';
		},
		tagCache: () => ({ getByTag: async (tag: string) => opts.byTag?.[tag] ?? [] }),
	});
	return { handler, calls, lookups };
};

void describe('cacheKeyToPagePath', () => {
	void it('maps route-scoped cache keys to their page path', () => {
		assert.deepStrictEqual(cacheKeyToPagePath(PAGE_KEY), { path: '/isr-tag', pagesRouter: false });
		assert.deepStrictEqual(cacheKeyToPagePath(`/route-cache/PAGES/${HASH}/$/index`), {
			path: '/',
			pagesRouter: true,
		});
		assert.deepStrictEqual(cacheKeyToPagePath(`route-cache/APP_ROUTE/${HASH}/$/feed.xml`), {
			path: '/feed.xml',
			pagesRouter: false,
		});
	});

	void it('skips data-cache keys, which the CDN never caches', () => {
		assert.strictEqual(cacheKeyToPagePath(HASH), undefined);
		assert.strictEqual(cacheKeyToPagePath(''), undefined);
	});

	void it("skips 'use cache' (composable cache) keys, which are not page paths", () => {
		// Next's serialised `[buildId, id, args]` for a `'use cache'` function.
		assert.strictEqual(cacheKeyToPagePath(`["development","${'7f'.repeat(21)}",[]]`), undefined);
		assert.strictEqual(cacheKeyToPagePath(`["b1","${'c'.repeat(42)}",[{"slug":"hello"}]]`), undefined);
	});

	void it('reads the path-style keys of older Next releases', () => {
		assert.deepStrictEqual(cacheKeyToPagePath('blog/hello'), { path: '/blog/hello', pagesRouter: false });
		assert.deepStrictEqual(cacheKeyToPagePath('index'), { path: '/', pagesRouter: false });
	});
});

void describe('toInvalidationPaths', () => {
	void it('prefixes the basePath, adds Pages Router data routes and deduplicates', () => {
		assert.deepStrictEqual(
			toInvalidationPaths(
				[
					{ path: '/a', pagesRouter: false },
					{ path: '/a', pagesRouter: false },
					{ path: '/', pagesRouter: true },
				],
				{ basePath: '/docs', buildId: 'B1' },
			),
			['/docs/a*', '/docs', '/docs/', '/docs/_next/data/B1/index.json*'],
		);
	});

	void it('covers the query-string and trailing-slash variants of a page with one wildcard path', () => {
		// The SSR cache policy keys on the query string (`/isr-tag?utm_source=x`),
		// and `trailingSlash: true` caches the page as `/isr-tag/`.
		assert.deepStrictEqual(
			toInvalidationPaths([
				{ path: '/isr-tag', pagesRouter: false },
				{ path: '/blog/hello/', pagesRouter: false },
			]),
			['/isr-tag*', '/blog/hello*'],
		);
		// The root page stays exact: a `/*` would purge the whole distribution.
		assert.deepStrictEqual(toInvalidationPaths([{ path: '/', pagesRouter: false }]), ['/']);
	});

	void it('percent-encodes only non-ASCII and RFC 1738 unsafe characters', () => {
		assert.deepStrictEqual(toInvalidationPaths([{ path: '/blog/héllo world', pagesRouter: false }]), [
			'/blog/h%C3%A9llo%20world*',
		]);
		// CloudFront misses an invalidation whose safe characters are encoded.
		assert.deepStrictEqual(
			toInvalidationPaths([
				{ path: '/@alice', pagesRouter: false },
				{ path: '/tags/c++', pagesRouter: false },
				{ path: '/a:b,c;d=e&f$g', pagesRouter: false },
				{ path: '/tags/c%2B%2B', pagesRouter: false },
			]),
			['/@alice*', '/tags/c++*', '/a:b,c;d=e&f$g*'],
		);
	});

	void it('cuts a path back before a ~, which CloudFront does not accept', () => {
		assert.deepStrictEqual(toInvalidationPaths([{ path: '/users/~bob', pagesRouter: false }]), ['/users/*']);
	});

	void it(`collapses more than ${MAX_WILDCARD_PATHS} wildcard paths into one /*`, () => {
		const pages = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `/p${i}`, pagesRouter: false }));
		// CloudFront allows 15 wildcard paths in progress per account (not adjustable).
		assert.strictEqual(MAX_WILDCARD_PATHS, 15);
		assert.strictEqual(toInvalidationPaths(pages(MAX_WILDCARD_PATHS)).length, MAX_WILDCARD_PATHS);
		assert.deepStrictEqual(toInvalidationPaths(pages(MAX_WILDCARD_PATHS + 1)), ['/*']);
		assert.deepStrictEqual(toInvalidationPaths(pages(MAX_WILDCARD_PATHS + 1), { basePath: '/docs/' }), ['/docs*']);
		// A Pages Router page takes two wildcard paths (the page and its data route).
		const pagesRouter = Array.from({ length: 8 }, (_, i) => ({ path: `/p${i}`, pagesRouter: true }));
		assert.deepStrictEqual(toInvalidationPaths(pagesRouter, { buildId: 'b1' }), ['/*']);
		// The exact root paths don't count against the wildcard cap.
		const withRoot = [{ path: '/', pagesRouter: false }, ...pages(MAX_WILDCARD_PATHS)];
		assert.strictEqual(toInvalidationPaths(withRoot, { basePath: '/docs' }).length, MAX_WILDCARD_PATHS + 2);
	});
});

void describe('createCdnInvalidationHandler', () => {
	void it('invalidates the pages carrying a revalidated fetch / unstable_cache tag', async () => {
		// The tag rows OpenNext writes for a page whose data is cached under `kb`:
		// two data-cache entries and the page itself.
		const { handler, calls, lookups } = fakeHandler({ byTag: { kb: [HASH, 'b'.repeat(64), PAGE_KEY] } });
		await handler.invalidateTags(['kb']);
		assert.deepStrictEqual(calls, [{ distributionId: 'E2EXAMPLE123', paths: ['/isr-tag*'] }]);
		assert.deepStrictEqual(lookups, ['/cdk-blocks/hosting/App/x/distribution-id']);
	});

	void it('invalidates the path a revalidatePath() soft tag names, with or without a tag row', async () => {
		const { handler, calls } = fakeHandler({
			byTag: { '_N_T_/isr': [`route-cache/APP_PAGE/${HASH}/$/isr`] },
		});
		await handler.invalidateTags(['_N_T_/isr']);
		await handler.invalidateTags(['_N_T_/never-cached']);
		// Next 16 tags the root as both `_N_T_/` and `_N_T_/index`: one exact `/`.
		await handler.invalidateTags(['_N_T_/', '_N_T_/index']);
		// A layout or `page` segment tag names no URL of its own.
		await handler.invalidateTags(['_N_T_/blog/[slug]/page']);
		assert.deepStrictEqual(
			calls.map((c) => c.paths),
			[['/isr*'], ['/never-cached*'], ['/']],
		);
	});

	void it('reads the distribution id once', async () => {
		const { handler, calls, lookups } = fakeHandler({ byTag: { kb: [PAGE_KEY] } });
		await handler.invalidateTags(['kb']);
		await handler.invalidateTags(['kb']);
		assert.strictEqual(calls.length, 2);
		assert.strictEqual(lookups.length, 1);
	});

	void it('uses the next-mode tag cache lookup when OpenNext provides it', async () => {
		const calls: string[][] = [];
		const handler = createCdnInvalidationHandler({
			env: { [CDN_INVALIDATION_PARAM_ENV]: 'p' },
			createInvalidation: async (_id, paths) => {
				calls.push(paths);
			},
			readDistributionId: async () => 'E1',
			tagCache: () => ({ getPathsByTags: async () => [`/route-cache/APP_PAGE/${HASH}/$/news`] }),
		});
		await handler.invalidateTags(['news']);
		assert.deepStrictEqual(calls, [['/news*']]);
	});

	void it('invalidates the paths OpenNext passes after res.revalidate / an ISR refresh', async () => {
		const { handler, calls } = fakeHandler({
			env: {
				[CDN_INVALIDATION_PARAM_ENV]: 'p',
				[CDN_INVALIDATION_BASE_PATH_ENV]: '/docs',
				OPEN_NEXT_BUILD_ID: 'B1',
			},
		});
		await handler.invalidatePaths([
			{ initialPath: '/app-page', resolvedRoutes: [{ route: '/app-page', type: 'app' }] },
			{ initialPath: 'pages-page', resolvedRoutes: [{ route: '/pages-page', type: 'page' }] },
		]);
		assert.deepStrictEqual(calls[0]?.paths, [
			'/docs/app-page*',
			'/docs/pages-page*',
			'/docs/_next/data/B1/pages-page.json*',
		]);
	});

	void it('does not prefix the basePath again onto a path that already carries it', async () => {
		const { handler, calls } = fakeHandler({
			env: {
				[CDN_INVALIDATION_PARAM_ENV]: 'p',
				[CDN_INVALIDATION_BASE_PATH_ENV]: '/docs',
				NEXT_BUILD_ID: 'B1',
			},
		});
		// `res.revalidate('/docs/blog/hello')` with `basePath: '/docs'`.
		await handler.invalidatePaths([
			{ initialPath: '/docs/blog/hello', resolvedRoutes: [{ route: '/blog/[slug]', type: 'page' }] },
			{ initialPath: '/docs', resolvedRoutes: [{ route: '/', type: 'app' }] },
		]);
		assert.deepStrictEqual(calls[0]?.paths, [
			'/docs/blog/hello*',
			'/docs/_next/data/B1/blog/hello.json*',
			'/docs',
			'/docs/',
		]);
	});

	void it("builds the data route from Next's build id, not the deploymentId", async () => {
		// With `deploymentId` set, OpenNext sets OPEN_NEXT_BUILD_ID to it while
		// `/_next/data/<id>/…` URLs keep Next's build id (NEXT_BUILD_ID).
		const { handler, calls } = fakeHandler({
			env: { [CDN_INVALIDATION_PARAM_ENV]: 'p', NEXT_BUILD_ID: 'NEXTID', OPEN_NEXT_BUILD_ID: 'dpl_1' },
		});
		await handler.invalidatePaths([{ initialPath: '/blog/hello', resolvedRoutes: [{ type: 'page' }] }]);
		assert.deepStrictEqual(calls[0]?.paths, ['/blog/hello*', '/_next/data/NEXTID/blog/hello.json*']);
	});

	void it('is a no-op without the distribution parameter (another front door, local runs)', async () => {
		const { handler, calls, lookups } = fakeHandler({ env: {}, byTag: { kb: [PAGE_KEY] } });
		await handler.invalidateTags(['kb']);
		await handler.invalidatePaths([{ initialPath: '/a', resolvedRoutes: [{ type: 'app' }] }]);
		assert.strictEqual(calls.length, 0);
		assert.strictEqual(lookups.length, 0);
	});

	void it('issues nothing when no tagged page is cached', async () => {
		const { handler, calls } = fakeHandler({ byTag: { kb: [HASH, `["b1","${'c'.repeat(42)}",[]]`] } });
		await handler.invalidateTags(['kb']);
		assert.strictEqual(calls.length, 0);
	});

	void it('falls back to one /* when CloudFront has too many invalidations in progress', async () => {
		const calls: string[][] = [];
		const handler = createCdnInvalidationHandler({
			env: { [CDN_INVALIDATION_PARAM_ENV]: 'p', [CDN_INVALIDATION_BASE_PATH_ENV]: '/docs' },
			createInvalidation: async (_id, paths) => {
				calls.push(paths);
				if (paths.length > 1) {
					throw Object.assign(new Error('Your request contains too many invalidations.'), {
						name: 'TooManyInvalidationsInProgress',
					});
				}
			},
			readDistributionId: async () => 'E1',
			tagCache: () => ({ getByTag: async () => [PAGE_KEY, `route-cache/APP_PAGE/${HASH}/$/other`] }),
		});
		await handler.invalidateTags(['kb']);
		assert.deepStrictEqual(calls, [['/docs/isr-tag*', '/docs/other*'], ['/docs*']]);
	});

	void it('does not retry a single-path invalidation or another error', async () => {
		const tooMany = Object.assign(new Error('too many'), { name: 'TooManyInvalidationsInProgress' });
		for (const [keys, error] of [
			[[PAGE_KEY], tooMany],
			[[PAGE_KEY, `route-cache/APP_PAGE/${HASH}/$/other`], new Error('AccessDenied')],
		] as const) {
			const calls: string[][] = [];
			const handler = createCdnInvalidationHandler({
				env: { [CDN_INVALIDATION_PARAM_ENV]: 'p' },
				createInvalidation: async (_id, paths) => {
					calls.push(paths);
					throw error;
				},
				readDistributionId: async () => 'E1',
				tagCache: () => ({ getByTag: async () => [...keys] }),
			});
			await assert.rejects(handler.invalidateTags(['kb']), error);
			assert.strictEqual(calls.length, 1);
		}
	});

	void it('retries a failed distribution lookup on the next revalidation', async () => {
		let attempts = 0;
		const calls: string[][] = [];
		const handler = createCdnInvalidationHandler({
			env: { [CDN_INVALIDATION_PARAM_ENV]: 'p' },
			createInvalidation: async (_id, paths) => {
				calls.push(paths);
			},
			readDistributionId: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error('throttled');
				return 'E1';
			},
			tagCache: () => ({ getByTag: async () => [PAGE_KEY] }),
		});
		await assert.rejects(handler.invalidateTags(['kb']), /throttled/);
		await handler.invalidateTags(['kb']);
		assert.deepStrictEqual(calls, [['/isr-tag*']]);
	});
});

/**
 * Compile an `open-next.config.ts` the way OpenNext does for Node.js
 * (`compileOpenNextConfigNode`). OpenNext passes `--node-externals` split on
 * `,`, so with the flag unset `external` is `['']`, which keeps every import
 * external: the compiled config can load nothing from the app's
 * `node_modules` at run time.
 */
const compileLikeOpenNext = (configFile: string): string => {
	const out = buildSync({
		entryPoints: [configFile],
		bundle: true,
		format: 'esm',
		target: ['node18'],
		platform: 'node',
		external: [''],
		write: false,
		logLevel: 'silent',
		banner: {
			js: "import { createRequire as topLevelCreateRequire } from 'module';const require = topLevelCreateRequire(import.meta.url);",
		},
	});
	return out.outputFiles[0]?.text ?? '';
};

void describe('nextjsAdapter — CloudFront invalidation on on-demand revalidation', () => {
	let tmpDir: string;
	let configDuringBuild: string | undefined;
	let lenientBackup: string | undefined;
	let withEdge = false;
	/** Workspace build: OpenNext nests the real bundle under `default/<workspace-path>/`. */
	let nestedUnder: string | undefined;

	const writeOutput = (config: string | undefined): void => {
		const openNextDir = path.join(tmpDir, '.open-next');
		const serverDir = path.join(openNextDir, 'server-functions', 'default');
		fs.mkdirSync(serverDir, { recursive: true });
		fs.writeFileSync(path.join(serverDir, 'index.mjs'), 'export const handler = async () => {};');
		const configDir = nestedUnder ? path.join(serverDir, nestedUnder) : serverDir;
		fs.mkdirSync(configDir, { recursive: true });
		// OpenNext copies its compiled config into every function bundle.
		if (config !== undefined) fs.writeFileSync(path.join(configDir, 'open-next.config.mjs'), config);
		fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });
		fs.mkdirSync(path.join(openNextDir, 'cache'), { recursive: true });
		fs.mkdirSync(path.join(openNextDir, 'revalidation-function'), { recursive: true });
		fs.writeFileSync(
			path.join(openNextDir, 'open-next.output.json'),
			JSON.stringify({
				origins: {
					default: {
						type: 'function',
						handler: 'index.handler',
						bundle: '.open-next/server-functions/default',
						streaming: true,
					},
				},
				...(withEdge
					? {
							edgeFunctions: {
								edge1: { bundle: '.open-next/server-functions/edge1', handler: 'index.handler' },
							},
						}
					: {}),
				behaviors: [{ pattern: '/*', origin: 'default' }],
				additionalProps: {},
			}),
		);
	};

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-nextjs-cdn-inval-'));
		configDuringBuild = undefined;
		withEdge = false;
		nestedUnder = undefined;
		mock.method(spawn, 'sync', () => {
			const cfg = path.join(tmpDir, 'open-next.config.ts');
			configDuringBuild = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf-8') : undefined;
			writeOutput(configDuringBuild === undefined ? undefined : compileLikeOpenNext(cfg));
		});
		lenientBackup = process.env.HOSTING_LENIENT_PATCHES;
		process.env.HOSTING_LENIENT_PATCHES = '1';
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		mock.restoreAll();
		if (lenientBackup === undefined) delete process.env.HOSTING_LENIENT_PATCHES;
		else process.env.HOSTING_LENIENT_PATCHES = lenientBackup;
	});

	const serverDir = () => path.join(tmpDir, '.open-next', 'server-functions', 'default');

	void it('installs the CloudFront invalidation handler and flags the cache for it', () => {
		const manifest = nextjsAdapter({ projectDir: tmpDir });
		assert.match(configDuringBuild ?? '', /cdnInvalidation: async \(\) =>/);
		assert.doesNotMatch(configDuringBuild ?? '', /^import /m, 'no static import: OpenNext keeps imports external');
		// `next build` type-checks root `*.ts` files; `import.meta` fails under `module: commonjs`.
		assert.match(configDuringBuild ?? '', /^\/\/ @ts-nocheck\n/);
		assert.ok(fs.existsSync(path.join(serverDir(), CDN_INVALIDATION_BUNDLE_FILE)), 'the handler bundle ships');
		assert.strictEqual(manifest.cache?.cdnInvalidation, true);
	});

	void it('the server function loads the handler from its own bundle, with no node_modules', async () => {
		nextjsAdapter({ projectDir: tmpDir });
		// Load it from a copy outside the project, as on Lambda (/var/task).
		const lambdaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-task-'));
		try {
			for (const file of ['open-next.config.mjs', CDN_INVALIDATION_BUNDLE_FILE]) {
				fs.copyFileSync(path.join(serverDir(), file), path.join(lambdaDir, file));
			}
			const config = (await import(pathToFileURL(path.join(lambdaDir, 'open-next.config.mjs')).href)) as {
				default: {
					default: {
						override: { cdnInvalidation: () => Promise<{ name: string; invalidateTags: InvalidateTags }> };
					};
				};
			};
			const resolved = await config.default.default.override.cdnInvalidation();
			assert.strictEqual(resolved.name, CDN_INVALIDATION_HANDLER_NAME);
			// Runs the import of the bundle (a no-op without the distribution parameter).
			await resolved.invalidateTags(['kb']);
		} finally {
			fs.rmSync(lambdaDir, { recursive: true, force: true });
		}
	});

	void it('ships the handler next to the nested config of a workspace (monorepo) build', () => {
		nestedUnder = path.join('apps', 'web');
		const manifest = nextjsAdapter({ projectDir: tmpDir });
		const nested = path.join(serverDir(), 'apps', 'web');
		assert.ok(fs.existsSync(path.join(nested, CDN_INVALIDATION_BUNDLE_FILE)), 'the bundle sits next to the config');
		assert.strictEqual(manifest.cache?.cdnInvalidation, true);
	});

	void it('loads the handler bundle on the first revalidation, not when the override is resolved', async () => {
		nextjsAdapter({ projectDir: tmpDir });
		// Without the bundle (as if it were never copied), resolving the override
		// (what OpenNext does on every cold start) still works; only a
		// revalidation fails, and OpenNext logs it.
		const lambdaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-task-'));
		try {
			fs.copyFileSync(path.join(serverDir(), 'open-next.config.mjs'), path.join(lambdaDir, 'open-next.config.mjs'));
			const config = (await import(pathToFileURL(path.join(lambdaDir, 'open-next.config.mjs')).href)) as {
				default: {
					default: {
						override: {
							cdnInvalidation: () => Promise<{ name: string; invalidateTags: (t: string[]) => Promise<void> }>;
						};
					};
				};
			};
			const resolved = await config.default.default.override.cdnInvalidation();
			assert.strictEqual(resolved.name, CDN_INVALIDATION_HANDLER_NAME);
			await assert.rejects(resolved.invalidateTags(['kb']), /Cannot find module|ERR_MODULE_NOT_FOUND/);
		} finally {
			fs.rmSync(lambdaDir, { recursive: true, force: true });
		}
	});

	void it('leaves it out for @opennextjs/aws before 4.1.14, which never calls invalidateTags', () => {
		const pkgDir = path.join(tmpDir, 'node_modules', '@opennextjs', 'aws');
		fs.mkdirSync(pkgDir, { recursive: true });
		fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@opennextjs/aws', version: '3.10.4' }));
		const manifest = nextjsAdapter({ projectDir: tmpDir });
		assert.doesNotMatch(configDuringBuild ?? '', /cdnInvalidation/);
		assert.strictEqual(manifest.cache?.cdnInvalidation, undefined);
	});

	void it("leaves a project's own open-next.config.ts alone", () => {
		fs.writeFileSync(
			path.join(tmpDir, 'open-next.config.ts'),
			`export default { default: { override: { converter: 'aws-apigw-v1', wrapper: 'aws-lambda-streaming' } } };\n`,
		);
		const manifest = nextjsAdapter({ projectDir: tmpDir });
		assert.ok(!fs.existsSync(path.join(serverDir(), CDN_INVALIDATION_BUNDLE_FILE)));
		assert.strictEqual(manifest.cache?.cdnInvalidation, undefined);
	});

	void it('leaves it out without a tag cache (skipIsr)', () => {
		const manifest = withBuildProfile({ skipIsr: true }, () => nextjsAdapter({ projectDir: tmpDir }));
		assert.doesNotMatch(configDuringBuild ?? '', /cdnInvalidation/);
		assert.strictEqual(manifest.cache?.cdnInvalidation, undefined);
	});

	void it('leaves it out of a build with edge routes (the config is also compiled for the edge)', () => {
		withEdge = true;
		fs.mkdirSync(path.join(tmpDir, '.next', 'server'), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, '.next', 'server', 'middleware-manifest.json'),
			JSON.stringify({
				version: 3,
				middleware: {},
				functions: {
					'/api/edge/route': { name: 'app/api/edge/route', matchers: [{ originalSource: '/api/edge' }] },
				},
			}),
		);
		const manifest = nextjsAdapter({ projectDir: tmpDir });
		assert.match(configDuringBuild ?? '', /runtime: 'edge'/, 'the edge function block is generated');
		assert.doesNotMatch(configDuringBuild ?? '', /cdnInvalidation/);
		assert.strictEqual(manifest.cache?.cdnInvalidation, undefined);
	});
});
