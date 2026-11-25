// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Caller-input checks shared by the mock (`index.mock.ts`), the AWS runtime
 * (`index.aws.ts`) and `asAgentTool()` (`agent-tool.ts`), so a filter is accepted
 * or rejected the same way on every path. See "Mock and AWS validation parity"
 * in `docs/reference/building-block-structure.md`.
 */
import { blocksError, KnowledgeBaseErrors } from './errors.js';
import type { MetadataFilter } from './types.js';

/** The condition operators a {@link MetadataFilter} supports. v1 ships `equals` only. */
const SUPPORTED_OPERATORS: ReadonlySet<string> = new Set(['equals']);

/**
 * Describe what is wrong with a metadata filter, or return `undefined` when it is valid.
 *
 * A valid filter is a non-empty plain object whose every key is a non-empty string mapped to a
 * condition object with exactly one supported operator (`equals`) holding a non-empty string.
 * Every other shape is reported, because each one would otherwise widen the search instead of
 * narrowing it: `null` and `{}` ran an unfiltered search on both runtimes, and a condition
 * without a string `equals` matched every document lacking the key in the mock and reached
 * Bedrock as `{ equals: { key } }` with no value.
 *
 * The returned text completes a sentence about the filter ("... is null") and quotes key
 * names but never condition values, so it is safe to put in a branded error message.
 */
export function metadataFilterProblem(filter: unknown): string | undefined {
	if (filter === null) return 'is null';
	if (typeof filter !== 'object') return `is of type ${typeof filter}, not an object`;
	if (Array.isArray(filter)) return 'is an array, not an object';
	const entries = Object.entries(filter);
	if (entries.length === 0) return 'is empty';
	for (const [key, condition] of entries) {
		if (key.length === 0) return 'has an empty key';
		if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
			return `has no condition object for "${key}"`;
		}
		const operators = Object.keys(condition);
		// Reject unknown operators rather than ignore them: a caller who writes
		// `{ contains: 'x' }` expects narrowing that v1 can't provide.
		const unsupported = operators.find((op) => !SUPPORTED_OPERATORS.has(op));
		if (unsupported !== undefined) {
			return `uses unsupported operator "${unsupported}" for "${key}" (only \`equals\` is supported)`;
		}
		const equals: unknown = (condition as { equals?: unknown }).equals;
		// An empty string is rejected too: it is what a missing id (`user.tenantId ?? ''`)
		// usually turns into, and it never names a real scope.
		if (typeof equals !== 'string' || equals.length === 0) return `has no non-empty string \`equals\` for "${key}"`;
	}
	return undefined;
}

/**
 * Check the `filter` passed to `retrieve()`. Call it before any search or SDK call.
 *
 * Only an omitted (`undefined`) filter means "search everything". Any other value must be a
 * valid {@link MetadataFilter} (see {@link metadataFilterProblem}); an explicit `null`, `{}` or a
 * malformed condition throws `KnowledgeBaseErrors.ValidationError`.
 *
 * @returns The filter, typed, or `undefined` when none was given.
 * @throws {KnowledgeBaseValidationError} If the filter is present but not a valid `MetadataFilter`.
 */
export function validateRetrieveFilter(filter: unknown): MetadataFilter | undefined {
	if (filter === undefined) return undefined;
	const problem = metadataFilterProblem(filter);
	if (problem !== undefined) {
		throw blocksError(
			KnowledgeBaseErrors.ValidationError,
			`retrieve() filter ${problem}. Pass a filter such as { folder: { equals: 'faq' } }, ` +
				'or omit `filter` to search the whole knowledge base.',
		);
	}
	return filter as MetadataFilter;
}
