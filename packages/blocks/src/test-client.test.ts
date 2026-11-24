// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `createTestClient()` (`aws-cdk-blocks/utils`): each test user's calls
 * carry that user's cookies and no one else's — not another test user's, not
 * the shared jar `installCookieJar()` puts on `fetch`. Against a real HTTP
 * server on loopback that sets a session cookie per sign-in.
 */

import assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { ApiNamespaceClient } from '@aws-cdk-blocks/core/client';
import { createTestClient, getLastAuthCode, installCookieJar } from './utils.js';

type SessionApi = {
	signIn(name: string): Promise<{ ok: true }>;
	whoAmI(): Promise<string | null>;
};

let server: Server;
let url: string;

before(async () => {
	server = createServer((req, res) => {
		let body = '';
		req.on('data', (c) => {
			body += c;
		});
		req.on('end', () => {
			const rpc: { method: string; params: unknown[]; id: number } = JSON.parse(body);
			const cookie = /(?:^|; )session=([^;]*)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
			const headers: Record<string, string | string[]> = { 'content-type': 'application/json' };
			let result: unknown;
			if (rpc.method.endsWith('.signIn')) {
				headers['set-cookie'] = [`session=${String(rpc.params[0])}; Path=/; HttpOnly`];
				result = { ok: true };
			} else {
				result = cookie;
			}
			res.writeHead(200, headers).end(JSON.stringify({ jsonrpc: '2.0', result, id: rpc.id }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cdk-blocks/api`;
});

after(() => {
	server.close();
});

describe('createTestClient', () => {
	test('two test users hold two sessions at once', async () => {
		const app = {
			api: ApiNamespaceClient<SessionApi>('api', { url }),
			other: ApiNamespaceClient<SessionApi>('other', { url }),
		};
		const alice = createTestClient(app);
		const bob = createTestClient(app);
		await alice.api.signIn('alice');
		await bob.api.signIn('bob');
		assert.strictEqual(await alice.api.whoAmI(), 'alice');
		assert.strictEqual(await bob.api.whoAmI(), 'bob');
		// One user's clients share the jar: a session started on one is sent by the others.
		assert.strictEqual(await alice.other.whoAmI(), 'alice');
		// The clients passed in are unchanged: they send no cookie.
		assert.strictEqual(await app.api.whoAmI(), null);
		assert.strictEqual(alice.api, alice.api, 'the same bound client each time');
	});

	test('a single client gets its own jar; values that are not clients pass through', async () => {
		const api = ApiNamespaceClient<SessionApi>('api', { url });
		const carol = createTestClient(api);
		await carol.signIn('carol');
		assert.strictEqual(await carol.whoAmI(), 'carol');
		const mixed = createTestClient({ api, version: 3 });
		assert.strictEqual(mixed.version, 3);
		assert.strictEqual(await mixed.api.whoAmI(), null);
	});

	test("installCookieJar's shared jar and test users' jars never mix", async () => {
		const restore = installCookieJar();
		try {
			const api = ApiNamespaceClient<SessionApi>('api', { url });
			await api.signIn('shared');
			const dave = createTestClient({ api });
			assert.strictEqual(await dave.api.whoAmI(), null, "the shared jar's cookie is not sent");
			await dave.api.signIn('dave');
			assert.strictEqual(await dave.api.whoAmI(), 'dave');
			assert.strictEqual(await api.whoAmI(), 'shared', "a test user's sign-in does not reach the shared jar");
		} finally {
			restore();
		}
	});

	test("installCookieJar keeps the caller's headers, whatever their shape", async () => {
		const original = globalThis.fetch;
		const seen: Headers[] = [];
		globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			seen.push(new Headers(init?.headers));
			return new Response('{}', { headers: { 'set-cookie': 'session=s1; Path=/' } });
		}) as typeof fetch;
		const restore = installCookieJar();
		try {
			await fetch(url);
			for (const headers of [new Headers({ 'x-a': '1' }), { 'x-a': '1' }, [['x-a', '1']] as [string, string][]]) {
				await fetch(url, { headers });
				const sent = seen.at(-1);
				assert.strictEqual(sent?.get('x-a'), '1', JSON.stringify(headers));
				assert.strictEqual(sent?.get('cookie'), 'session=s1');
			}
		} finally {
			restore();
			globalThis.fetch = original;
		}
	});

	test('installCookieJar sends a Cookie header the caller set instead of its own', async () => {
		const original = globalThis.fetch;
		const seen: Headers[] = [];
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			// What the request goes out with: `init.headers` when given, else the `Request`'s own.
			seen.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
			return new Response('{}', { headers: { 'set-cookie': 'session=s1; Path=/' } });
		}) as typeof fetch;
		const restore = installCookieJar();
		try {
			await fetch(url);
			await fetch(url);
			assert.strictEqual(
				seen.at(-1)?.get('cookie'),
				'session=s1',
				'with no Cookie header, the jar sends its own',
			);
			const tampered = 'session=tampered';
			const shapes: HeadersInit[] = [
				new Headers({ Cookie: tampered, 'x-a': '1' }),
				{ Cookie: tampered, 'x-a': '1' },
				{ cookie: tampered, 'x-a': '1' },
				[
					['COOKIE', tampered],
					['x-a', '1'],
				],
			];
			for (const headers of shapes) {
				await fetch(url, { headers });
				const sent = seen.at(-1);
				assert.strictEqual(sent?.get('cookie'), tampered, JSON.stringify(headers));
				assert.strictEqual(sent?.get('x-a'), '1', JSON.stringify(headers));
			}
			await fetch(new Request(url, { headers: { Cookie: tampered, 'x-a': '1' } }));
			assert.strictEqual(seen.at(-1)?.get('cookie'), tampered, 'a Request with its own Cookie header');
			assert.strictEqual(seen.at(-1)?.get('x-a'), '1', "a Request's other headers");
			await fetch(new Request(url, { headers: { 'x-a': '1' } }));
			assert.strictEqual(seen.at(-1)?.get('cookie'), 'session=s1', 'a Request without one gets the jar cookie');
			assert.strictEqual(seen.at(-1)?.get('x-a'), '1', "a Request's headers are kept next to the jar cookie");
		} finally {
			restore();
			globalThis.fetch = original;
		}
	});

	test('a test user sends through the global fetch as it is at call time (a mock installed after import)', async () => {
		const api = ApiNamespaceClient<SessionApi>('api', { url });
		const erin = createTestClient({ api });
		const original = globalThis.fetch;
		const seen: string[] = [];
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			seen.push(String(input));
			return original(input, init);
		}) as typeof fetch;
		try {
			await erin.api.signIn('erin');
			assert.strictEqual(await erin.api.whoAmI(), 'erin');
			assert.deepStrictEqual(seen, [`${url}/api`, `${url}/api`]);
		} finally {
			globalThis.fetch = original;
		}
		// Restored: later calls go straight to the restored fetch, and keep the session.
		assert.strictEqual(await erin.api.whoAmI(), 'erin');
		assert.strictEqual(seen.length, 2);
	});

	test('getLastAuthCode is exported next to it (from @aws-cdk-blocks/bb-auth/testing)', () => {
		assert.strictEqual(typeof getLastAuthCode, 'function');
	});
});
