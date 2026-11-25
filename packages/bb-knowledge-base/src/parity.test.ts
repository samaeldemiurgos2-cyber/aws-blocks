// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock↔AWS parity for `KnowledgeBase.retrieve()` input validation.
 *
 * Each case runs the same input through the local mock and through the AWS
 * runtime with `BedrockAgentRuntimeClient.send` stubbed, and asserts both reach
 * the same outcome: the same named `KnowledgeBaseErrors` error (and message), or
 * success. For success cases the captured `RetrieveCommand` input is asserted
 * too, so a stub that rejects every command cannot make a case pass vacuously,
 * and for rejected cases the test asserts that nothing reached Bedrock.
 *
 * Following `bb-file-bucket/src/parity.test.ts`.
 */
import assert from 'node:assert';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isBlocksError, Scope } from '@aws-cdk-blocks/core';
import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { KnowledgeBase as AwsKnowledgeBase } from './index.aws.js';
import { KnowledgeBaseErrors, KnowledgeBase as MockKnowledgeBase } from './index.mock.js';
import type { RetrieveOptions } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_SRC = join(__dirname, '..', 'test-fixtures', 'knowledge');
const SOURCE = 'kb-parity-knowledge-tmp';
const SOURCE_DIR = join(process.cwd(), SOURCE);

let n = 0;
const uniqueId = () => `kbparity${Date.now()}x${n++}`;

type Outcome = { ok: true } | { ok: false; name: string; message: string };

async function outcomeOf(fn: () => Promise<unknown>): Promise<Outcome> {
	try {
		await fn();
		return { ok: true };
	} catch (e) {
		const err = e as Error;
		return { ok: false, name: err.name, message: err.message };
	}
}

interface Case {
	label: string;
	/** Passed to `retrieve()` as-is; JS and RPC callers can send values outside `RetrieveOptions`. */
	options: unknown;
	/** `null` = success; otherwise the expected `KnowledgeBaseErrors` name. */
	error: string | null;
	/** For success cases: the `filter` the AWS entry must send to Bedrock (`undefined` = none). */
	sentFilter?: unknown;
}

const cases: Case[] = [
	{ label: 'no options', options: undefined, error: null, sentFilter: undefined },
	{ label: 'an omitted filter', options: { maxResults: 3 }, error: null, sentFilter: undefined },
	{ label: 'filter: undefined', options: { filter: undefined }, error: null, sentFilter: undefined },
	{
		label: 'a single equals condition',
		options: { filter: { folder: { equals: 'faq' } } },
		error: null,
		sentFilter: { equals: { key: 'folder', value: 'faq' } },
	},
	{
		label: 'two equals conditions (AND)',
		options: { filter: { folder: { equals: 'faq' }, category: { equals: 'billing' } } },
		error: null,
		sentFilter: {
			andAll: [{ equals: { key: 'folder', value: 'faq' } }, { equals: { key: 'category', value: 'billing' } }],
		},
	},
	{ label: 'filter: null', options: { filter: null }, error: KnowledgeBaseErrors.ValidationError },
	{ label: 'an empty filter object', options: { filter: {} }, error: KnowledgeBaseErrors.ValidationError },
	{ label: 'a filter array', options: { filter: [] }, error: KnowledgeBaseErrors.ValidationError },
	{ label: 'a string filter', options: { filter: 'faq' }, error: KnowledgeBaseErrors.ValidationError },
	{
		label: 'a condition with no operator',
		options: { filter: { folder: {} } },
		error: KnowledgeBaseErrors.ValidationError,
	},
	{
		label: 'a condition on an unknown key with no operator',
		options: { filter: { nokey: {} } },
		error: KnowledgeBaseErrors.ValidationError,
	},
	{ label: 'a null condition', options: { filter: { folder: null } }, error: KnowledgeBaseErrors.ValidationError },
	{
		label: 'a bare string condition',
		options: { filter: { folder: 'faq' } },
		error: KnowledgeBaseErrors.ValidationError,
	},
	{
		label: 'equals: undefined',
		options: { filter: { folder: { equals: undefined } } },
		error: KnowledgeBaseErrors.ValidationError,
	},
	{
		label: 'equals: null',
		options: { filter: { folder: { equals: null } } },
		error: KnowledgeBaseErrors.ValidationError,
	},
	{
		label: 'a non-string equals',
		options: { filter: { folder: { equals: 1 } } },
		error: KnowledgeBaseErrors.ValidationError,
	},
	{
		label: 'an empty-string equals',
		options: { filter: { folder: { equals: '' } } },
		error: KnowledgeBaseErrors.ValidationError,
	},
	{
		label: 'an unknown operator',
		options: { filter: { folder: { contains: 'faq' } } },
		error: KnowledgeBaseErrors.ValidationError,
	},
	{
		label: 'equals next to an unknown operator',
		options: { filter: { folder: { equals: 'faq', notEquals: 'guides' } } },
		error: KnowledgeBaseErrors.ValidationError,
	},
	{
		label: 'an empty key',
		options: { filter: { '': { equals: 'faq' } } },
		error: KnowledgeBaseErrors.ValidationError,
	},
	{
		label: 'one valid and one malformed condition',
		options: { filter: { folder: { equals: 'faq' }, tenant: {} } },
		error: KnowledgeBaseErrors.ValidationError,
	},
];

describe('KnowledgeBase.retrieve() validates the same filter the same way on mock and AWS', () => {
	before(() => {
		if (existsSync(SOURCE_DIR)) rmSync(SOURCE_DIR, { recursive: true, force: true });
		cpSync(FIXTURES_SRC, SOURCE_DIR, { recursive: true });
	});
	after(() => {
		rmSync(SOURCE_DIR, { recursive: true, force: true });
		rmSync('.cdk-blocks/local/data', { recursive: true, force: true });
	});

	for (const c of cases) {
		test(c.label, async () => {
			const options = c.options as RetrieveOptions | undefined;
			const mockKb = new MockKnowledgeBase(new Scope('app'), uniqueId(), { source: SOURCE });
			// Keep the mock's error so the brand can be checked without a second call.
			let mockError: unknown;
			const mockOutcome = await outcomeOf(async () => {
				try {
					await mockKb.retrieve('billing payment', options);
				} catch (e) {
					mockError = e;
					throw e;
				}
			});

			const scope = new Scope('app');
			const id = uniqueId();
			const envName = `BLOCKS_APP_${id.toUpperCase()}_KB_ID`;
			process.env[envName] = 'kb-parity';
			const inputs: { retrievalConfiguration?: { vectorSearchConfiguration?: { filter?: unknown } } }[] = [];
			const send = mock.method(
				BedrockAgentRuntimeClient.prototype,
				'send',
				async (cmd: { input: (typeof inputs)[number] }) => {
					inputs.push(cmd.input);
					return { retrievalResults: [] };
				},
			);
			let awsOutcome: Outcome;
			try {
				const awsKb = new AwsKnowledgeBase(scope, id, { source: SOURCE });
				awsOutcome = await outcomeOf(() => awsKb.retrieve('billing payment', options));
			} finally {
				send.mock.restore();
				delete process.env[envName];
			}

			assert.deepStrictEqual(awsOutcome, mockOutcome, 'mock and AWS must reach the same outcome');

			if (c.error === null) {
				assert.deepStrictEqual(mockOutcome, { ok: true });
				assert.strictEqual(inputs.length, 1, 'a valid filter must reach Bedrock exactly once');
				const sent = inputs[0].retrievalConfiguration?.vectorSearchConfiguration?.filter;
				assert.deepStrictEqual(sent, c.sentFilter);
			} else {
				assert.strictEqual(inputs.length, 0, 'a rejected filter must not reach Bedrock');
				assert.ok(isBlocksError(mockError, c.error), `expected a branded ${c.error} error`);
			}
		});
	}
});
