// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { KVStore } from '@aws-cdk-blocks/bb-kv-store';
import { z } from 'zod';

import { listLocalStores } from './bb-data.js';
import {
	describeKvStoreKeys,
	indexOfKvItem,
	isKvStoreFile,
	isStringKeyed,
	kvStoreFileOf,
	readKvItem,
	replaceKvItem,
	reservedFieldOf,
} from './kv-store-file.js';
import { type LocalWriteContext, putLocalRecord } from './local-writes.js';

const STRING_KEYS = { stringKeyed: true, keyFields: ['key'] };
const DECLARED_KEYS = { stringKeyed: false, keyFields: ['userId', 'createdAt'] };

describe('a data file shared with the KVStore block', () => {
	const TODO_KEY = { partitionKey: 'userId', sortKey: 'createdAt' } as const;
	const TODO_SCHEMA = z.object({ userId: z.string(), createdAt: z.number(), title: z.string() });
	const APP = { id: 'app' };
	const EXPIRES_AT = 4_000_000_000;

	const cwd = process.cwd();
	let projectRoot: string;
	before(() => {
		projectRoot = mkdtempSync(join(tmpdir(), 'kv-store-file-test-'));
		process.chdir(projectRoot);
	});
	after(() => {
		process.chdir(cwd);
		rmSync(projectRoot, { recursive: true, force: true });
	});

	function todoStore(id: string) {
		return new KVStore(APP, id, { schema: TODO_SCHEMA, key: TODO_KEY });
	}

	function itemsOnDisk(blockFullId: string): unknown[] {
		const stores = listLocalStores(projectRoot, blockFullId);
		assert.strictEqual(stores.length, 1, `expected one data file for ${blockFullId}`);
		const text = readFileSync(stores[0].file, 'utf-8');
		const parsed: unknown = JSON.parse(text);
		if (!isKvStoreFile(parsed)) assert.fail(`${stores[0].file} is not a KVStore data file: ${text}`);
		return parsed.items;
	}

	it('reads what a store with a string key wrote', async () => {
		const store = new KVStore<unknown>(APP, 'cache');
		const written = [
			{ key: 'greeting', value: 'hello' },
			{ key: 'profile', value: { name: 'Ada', tags: ['a'] } },
			{ key: 'scores', value: [1, 2] },
			{ key: 'otp', value: '123456', expiresAt: EXPIRES_AT },
		];
		for (const { key, value, expiresAt } of written) await store.put(key, value, { expiresAt });

		const items = itemsOnDisk(store.fullId);
		const keys = describeKvStoreKeys(items, []);
		assert.deepStrictEqual(keys, STRING_KEYS);
		const records = items.map((item) => readKvItem(item, keys));
		assert.strictEqual(records.length, written.length);
		for (const { key, value, expiresAt } of written) {
			assert.deepStrictEqual(await store.get(key), value);
			assert.deepStrictEqual(
				records.find((record) => record.keyValues?.key === key),
				expiresAt === undefined ? { keyValues: { key }, value } : { keyValues: { key }, value, expiresAt },
			);
		}
	});

	it('reads what a store with declared key fields wrote', async () => {
		const store = todoStore('todos');
		const written = [
			{ key: { userId: 'u1', createdAt: 9 }, title: 'first', expiresAt: EXPIRES_AT },
			{ key: { userId: 'u2', createdAt: 12 }, title: 'second' },
		];
		for (const { key, title, expiresAt } of written) await store.put(key, { title }, { expiresAt });

		const items = itemsOnDisk(store.fullId);
		const keys = describeKvStoreKeys(items, [TODO_KEY.partitionKey, TODO_KEY.sortKey]);
		assert.deepStrictEqual(keys, DECLARED_KEYS);
		const records = items.map((item) => readKvItem(item, keys));
		assert.strictEqual(records.length, written.length);
		for (const { key, title, expiresAt } of written) {
			const value = { ...key, title };
			const keyValues = { userId: key.userId, createdAt: String(key.createdAt) };
			assert.deepStrictEqual(await store.get(key), value);
			assert.deepStrictEqual(
				records.find((record) => record.keyValues?.userId === key.userId),
				expiresAt === undefined ? { keyValues, value } : { keyValues, value, expiresAt },
			);
		}
	});

	it('writes an edit that the store reads, with the key and the expiry it had', async () => {
		const key = { userId: 'u1', createdAt: 9 };
		const untouched = { userId: 'u2', createdAt: 12 };
		const store = todoStore('edited');
		await store.put(key, { title: 'first' }, { expiresAt: EXPIRES_AT });
		await store.put(untouched, { title: 'second' });
		const context: LocalWriteContext = {
			projectRoot,
			blockFullId: store.fullId,
			keySchema: TODO_KEY,
			detectDevServer: async () => ({
				serverUp: false,
				serverUrl: 'http://localhost:3000',
				port: 3000,
				portSource: 'default',
				namespaces: [],
				bbDataPresent: true,
			}),
		};

		const edit = await putLocalRecord(context, { userId: 'u1', createdAt: '9', title: 'edited' }, 'edit');
		assert.strictEqual(edit.ok, true, edit.message);

		const reopened = todoStore('edited');
		const entries = [];
		for await (const entry of reopened.scan()) entries.push(entry);
		assert.deepStrictEqual(entries, [
			{ key, value: { ...key, title: 'edited' }, expiresAt: EXPIRES_AT },
			{ key: untouched, value: { ...untouched, title: 'second' } },
		]);
		assert.deepStrictEqual(await reopened.get(key), { ...key, title: 'edited' });
	});
});

describe('isKvStoreFile', () => {
	it('accepts the versioned file, empty or not', () => {
		assert.strictEqual(isKvStoreFile({ version: 2, items: [] }), true);
		assert.strictEqual(isKvStoreFile({ version: 2, items: [{ _bkv_pk: 'a', _bkv_value: 1 }] }), true);
	});

	it('rejects an object map that only has the same two property names', () => {
		// The store of an earlier release: `version` and `items` are two keys of it.
		assert.strictEqual(isKvStoreFile({ version: '"v7"', items: '["a","b"]' }), false);
		assert.strictEqual(isKvStoreFile({ version: 2, items: { a: 1 } }), false);
		assert.strictEqual(isKvStoreFile({ version: 1, items: [] }), false);
		assert.strictEqual(isKvStoreFile({ items: [] }), false);
	});

	it('rejects what is not an object', () => {
		for (const parsed of [null, undefined, 2, 'store', [], [['k', {}]]]) {
			assert.strictEqual(isKvStoreFile(parsed), false);
		}
	});

	it('is the inverse of kvStoreFileOf', () => {
		const file = kvStoreFileOf([{ id: 'a' }]);
		assert.deepStrictEqual(file, { version: 2, items: [{ id: 'a' }] });
		assert.strictEqual(isKvStoreFile(file), true);
	});
});

describe('describeKvStoreKeys', () => {
	it('reports one key named `key` for a store whose items have _bkv_pk', () => {
		const items = [{ _bkv_pk: 'a', _bkv_value: 1 }];
		assert.strictEqual(isStringKeyed(items), true);
		assert.deepStrictEqual(describeKvStoreKeys(items, []), STRING_KEYS);
		// The attribute decides, not what the caller believes the key fields are.
		assert.deepStrictEqual(describeKvStoreKeys(items, ['userId']), STRING_KEYS);
	});

	it('reports the declared fields for a store whose items have none', () => {
		const items = [{ userId: 'u1', createdAt: 9 }];
		assert.strictEqual(isStringKeyed(items), false);
		assert.deepStrictEqual(describeKvStoreKeys(items, ['userId', 'createdAt']), DECLARED_KEYS);
		assert.deepStrictEqual(describeKvStoreKeys([], ['userId', 'createdAt']), DECLARED_KEYS);
	});

	it('names no key fields when it has neither', () => {
		assert.deepStrictEqual(describeKvStoreKeys([{ userId: 'u1' }], []), { stringKeyed: false, keyFields: [] });
		assert.deepStrictEqual(describeKvStoreKeys([], []), { stringKeyed: false, keyFields: [] });
	});

	it('ignores a _bkv_pk that is not a string', () => {
		assert.strictEqual(isStringKeyed([{ _bkv_pk: 7 }, 'stray', null]), false);
	});
});

describe('readKvItem — a store with no declared key', () => {
	it('reads a value that is not an object from _bkv_value', () => {
		assert.deepStrictEqual(readKvItem({ _bkv_pk: 'a', _bkv_value: 'hello' }, STRING_KEYS), {
			keyValues: { key: 'a' },
			value: 'hello',
		});
		assert.deepStrictEqual(readKvItem({ _bkv_pk: 'n', _bkv_value: null }, STRING_KEYS), {
			keyValues: { key: 'n' },
			value: null,
		});
		assert.deepStrictEqual(readKvItem({ _bkv_pk: 'l', _bkv_value: [1, 2] }, STRING_KEYS).value, [1, 2]);
	});

	it('reads an object value from the fields of the item, without the block attributes', () => {
		assert.deepStrictEqual(
			readKvItem({ _bkv_pk: 'u1', name: 'Ada', tags: ['a'], _bkv_ttl: 1_800_000_000 }, STRING_KEYS),
			{ keyValues: { key: 'u1' }, value: { name: 'Ada', tags: ['a'] }, expiresAt: 1_800_000_000 },
		);
	});

	it('names no key for an item without _bkv_pk', () => {
		assert.deepStrictEqual(readKvItem({ name: 'Ada' }, STRING_KEYS), { value: { name: 'Ada' } });
	});
});

describe('readKvItem — a store with declared key fields', () => {
	it('keeps the key fields in the value and reports them as strings', () => {
		assert.deepStrictEqual(
			readKvItem({ userId: 'u1', createdAt: 9, title: 'first', _bkv_ttl: 1_800_000_000 }, DECLARED_KEYS),
			{
				keyValues: { userId: 'u1', createdAt: '9' },
				value: { userId: 'u1', createdAt: 9, title: 'first' },
				expiresAt: 1_800_000_000,
			},
		);
	});

	it('reports no key, never half of one, when a key field is missing or is not a string or a number', () => {
		assert.strictEqual(readKvItem({ userId: 'u1', title: 'x' }, DECLARED_KEYS).keyValues, undefined);
		assert.strictEqual(readKvItem({ userId: 'u1', createdAt: null }, DECLARED_KEYS).keyValues, undefined);
		assert.strictEqual(readKvItem({ userId: { a: 1 }, createdAt: 9 }, DECLARED_KEYS).keyValues, undefined);
	});

	it('reports no key when the key fields are not known', () => {
		const read = readKvItem({ userId: 'u1', createdAt: 9 }, { stringKeyed: false, keyFields: [] });
		assert.deepStrictEqual(read, { value: { userId: 'u1', createdAt: 9 } });
	});

	it('leaves an expiry that is a field of the value in the value', () => {
		// A store with `ttl: 'expiresAt'` has no `_bkv_ttl`.
		assert.deepStrictEqual(readKvItem({ userId: 'u1', createdAt: 9, expiresAt: 1_800_000_000 }, DECLARED_KEYS), {
			keyValues: { userId: 'u1', createdAt: '9' },
			value: { userId: 'u1', createdAt: 9, expiresAt: 1_800_000_000 },
		});
	});
});

describe('readKvItem — entries that are not items', () => {
	it('returns an entry that is not an object as its own value', () => {
		assert.deepStrictEqual(readKvItem('stray', STRING_KEYS), { value: 'stray' });
		assert.deepStrictEqual(readKvItem(null, DECLARED_KEYS), { value: null });
		assert.deepStrictEqual(readKvItem([1], DECLARED_KEYS), { value: [1] });
	});

	it('does not report an expiry that is not a finite number', () => {
		assert.strictEqual(
			readKvItem({ _bkv_pk: 'a', _bkv_value: 1, _bkv_ttl: 'soon' }, STRING_KEYS).expiresAt,
			undefined,
		);
	});
});

describe('indexOfKvItem', () => {
	const items = [
		{ userId: 'u1', createdAt: 9, title: 'first' },
		'stray',
		{ userId: 'u1', createdAt: 12, title: 'second' },
		{ userId: 'u2', createdAt: 9, title: 'third' },
	];
	const fields = ['userId', 'createdAt'];

	it('finds the item by every key field, comparing a stored number as a string', () => {
		assert.strictEqual(indexOfKvItem(items, { userId: 'u1', createdAt: '12' }, fields), 2);
		assert.strictEqual(indexOfKvItem(items, { userId: 'u2', createdAt: '9' }, fields), 3);
	});

	it('returns -1 when no item has the key, or only part of it', () => {
		assert.strictEqual(indexOfKvItem(items, { userId: 'u3', createdAt: '9' }, fields), -1);
		assert.strictEqual(indexOfKvItem(items, { userId: 'u1' }, fields), -1);
	});

	it('returns -1 with no key fields, so nothing is addressed by accident', () => {
		assert.strictEqual(indexOfKvItem(items, {}, []), -1);
	});
});

describe('replaceKvItem', () => {
	it('keeps the key attributes as stored and the expiry, and takes the rest from the record', () => {
		const existing = { userId: 'u1', createdAt: 9, title: 'old', note: 'gone', _bkv_ttl: 1_800_000_000 };
		const item = replaceKvItem(existing, { userId: 'u1', createdAt: '9', title: 'new' }, ['userId', 'createdAt']);
		assert.deepStrictEqual(item, { userId: 'u1', createdAt: 9, title: 'new', _bkv_ttl: 1_800_000_000 });
	});

	it('adds no expiry to an item that had none', () => {
		const item = replaceKvItem({ id: 'a', n: 1 }, { id: 'a', n: 2 }, ['id']);
		assert.deepStrictEqual(item, { id: 'a', n: 2 });
	});

	it('does not change the record or the existing item', () => {
		const existing = { id: 'a', _bkv_ttl: 5 };
		const record = { id: 'a', n: 2 };
		replaceKvItem(existing, record, ['id']);
		assert.deepStrictEqual(existing, { id: 'a', _bkv_ttl: 5 });
		assert.deepStrictEqual(record, { id: 'a', n: 2 });
	});
});

describe('reservedFieldOf', () => {
	it('names the first top-level field with the block prefix', () => {
		assert.strictEqual(reservedFieldOf({ id: 'a', _bkv_ttl: 1 }), '_bkv_ttl');
		assert.strictEqual(reservedFieldOf({ _bkv_anything: 1 }), '_bkv_anything');
	});

	it('finds none in an ordinary record, at any depth below the top', () => {
		assert.strictEqual(reservedFieldOf({ id: 'a', nested: { _bkv_pk: 'x' }, bkv: 1 }), undefined);
	});
});
