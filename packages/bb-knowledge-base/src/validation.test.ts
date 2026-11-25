// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { isBlocksError } from '@aws-cdk-blocks/core';
import { KnowledgeBaseErrors } from './errors.js';
import { metadataFilterProblem, validateRetrieveFilter } from './validation.js';

describe('metadataFilterProblem', () => {
	test('accepts filters whose every condition has a non-empty string equals', () => {
		assert.strictEqual(metadataFilterProblem({ folder: { equals: 'faq' } }), undefined);
		assert.strictEqual(metadataFilterProblem({ folder: { equals: 'faq' }, tenant: { equals: 'acme' } }), undefined);
	});

	test('reports every shape that would not narrow the search', () => {
		const bad: unknown[] = [
			null,
			undefined,
			'faq',
			0,
			false,
			[],
			{},
			{ '': { equals: 'faq' } },
			{ folder: {} },
			{ folder: null },
			{ folder: 'faq' },
			{ folder: [] },
			{ folder: { equals: undefined } },
			{ folder: { equals: null } },
			{ folder: { equals: 1 } },
			{ folder: { equals: '' } },
			{ folder: { contains: 'faq' } },
			{ folder: { equals: 'faq', notEquals: 'guides' } },
			{ folder: { equals: 'faq' }, tenant: {} },
		];
		for (const value of bad) {
			assert.strictEqual(
				typeof metadataFilterProblem(value),
				'string',
				`expected a problem for ${JSON.stringify(value)}`,
			);
		}
	});
});

describe('validateRetrieveFilter', () => {
	test('an omitted filter means an unfiltered search', () => {
		assert.strictEqual(validateRetrieveFilter(undefined), undefined);
	});

	test('returns a valid filter unchanged', () => {
		const filter = { folder: { equals: 'faq' } };
		assert.strictEqual(validateRetrieveFilter(filter), filter);
	});

	test('throws KnowledgeBaseValidationError for an explicit null or an empty filter', () => {
		for (const value of [null, {}, { folder: {} }]) {
			assert.throws(
				() => validateRetrieveFilter(value),
				(e: unknown) => isBlocksError(e, KnowledgeBaseErrors.ValidationError),
				`expected a ValidationError for ${JSON.stringify(value)}`,
			);
		}
	});
});
