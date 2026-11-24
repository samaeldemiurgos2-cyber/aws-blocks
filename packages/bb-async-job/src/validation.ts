// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Caller-input checks shared by the mock and AWS runtime entries, so both reject
 * the same input with the same named error (see `parity.test.ts`).
 */
import { blocksError } from '@aws-cdk-blocks/core';
import { AsyncJobErrors } from './errors.js';

/** Largest per-message delay Amazon SQS accepts (15 minutes). */
export const MAX_DELAY_SECONDS = 900;

/**
 * Validate `SubmitOptions.delaySeconds`.
 *
 * SQS accepts an integer from 0 to {@link MAX_DELAY_SECONDS} on `SendMessage` and
 * on every `SendMessageBatch` entry and rejects anything else with
 * `InvalidParameterValue`. Checking it here gives the caller a named, branded
 * `ValidationFailed` error before anything is queued, instead of an SDK error
 * that reaches an RPC client as a nameless 500 (or, for a batch, a
 * `BatchSubmitFailed` wrapping it). `undefined` means the option was omitted.
 *
 * @throws {AsyncJobErrors.ValidationFailed} If `delaySeconds` is not an integer from 0 to 900.
 */
export function validateDelaySeconds(delaySeconds: number | undefined): void {
	if (delaySeconds === undefined) return;
	// Number.isInteger is false for NaN, ±Infinity, fractions and non-numbers.
	if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_DELAY_SECONDS) {
		throw blocksError(
			AsyncJobErrors.ValidationFailed,
			`delaySeconds must be an integer from 0 to ${MAX_DELAY_SECONDS}, received ${String(delaySeconds)}`,
		);
	}
}
