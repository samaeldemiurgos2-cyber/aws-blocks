// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The input constraints Cognito's API model puts on a new user's `Username`
 * and on a password, which the local engine applies so it refuses what a
 * real user pool refuses. Cognito checks them before anything else in the
 * operation (before the user is looked up or stored), and answers
 * `InvalidParameterException` ("1 validation error detected: Value at
 * 'username' failed to satisfy constraint: …").
 *
 * From the `cognito-idp` 2016-04-18 service model (the `UsernameType` and
 * `PasswordType` shapes; also on each operation's page of the API reference,
 * e.g. <https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_SignUp.html>):
 *
 * - `UsernameType`: length 1–128, pattern `[\p{L}\p{M}\p{S}\p{N}\p{P}]+`
 *   (letters, marks, symbols, numbers and punctuation: no whitespace, no
 *   control characters). It is the `Username` of `SignUp` and
 *   `AdminCreateUser`, also on a pool that signs in with email / phone.
 * - `PasswordType`: at most 256 characters. Its pattern (`[\S]+`) is matched
 *   as a search, so it only asks for one non-whitespace character, which the
 *   password policy's minimum length already implies.
 *
 * Lengths count Unicode code points, as Smithy's `@length` does on a string
 * (and as Cognito does, checked live).
 *
 * Cognito collects every violation into one message ("2 validation errors
 * detected: …"); these checks report only the first one. The client gets
 * `InvalidParameterException`'s fixed message either way, so only the server
 * log text differs.
 *
 * The pattern's character classes come from the Node runtime's Unicode tables,
 * while Cognito uses Unicode 13's, so a character assigned in Unicode 14 or
 * later (newer emoji, some scripts) is accepted here and refused by Cognito.
 *
 * @internal
 */

import { AuthErrors } from '../errors.js';
import { serviceError } from './native-mock-store.js';

const USERNAME_MAX_LENGTH = 128;
const PASSWORD_MAX_LENGTH = 256;
/** `UsernameType`'s pattern, anchored: every character must be in one of these classes. */
const USERNAME_PATTERN = /^[\p{L}\p{M}\p{S}\p{N}\p{P}]+$/u;

const codePoints = (value: string): number => [...value].length;

/**
 * Refuse a new user's `Username` that breaks Cognito's `UsernameType`
 * constraints: empty, longer than 128 characters, or with a character outside
 * letters, marks, symbols, numbers and punctuation (such as a space, a tab or
 * NUL).
 *
 * @throws `InvalidParameterException`.
 * @internal
 */
export function enforceUsernameConstraints(username: string): void {
	const length = codePoints(username);
	if (length < 1) {
		throw serviceError(
			AuthErrors.InvalidParameter,
			"1 validation error detected: Value at 'username' failed to satisfy constraint: Member must have length greater than or equal to 1",
		);
	}
	if (length > USERNAME_MAX_LENGTH) {
		throw serviceError(
			AuthErrors.InvalidParameter,
			`1 validation error detected: Value at 'username' failed to satisfy constraint: Member must have length less than or equal to ${USERNAME_MAX_LENGTH}`,
		);
	}
	if (!USERNAME_PATTERN.test(username)) {
		throw serviceError(
			AuthErrors.InvalidParameter,
			"1 validation error detected: Value at 'username' failed to satisfy constraint: Member must satisfy regular expression pattern: [\\p{L}\\p{M}\\p{S}\\p{N}\\p{P}]+",
		);
	}
}

/**
 * Refuse a password longer than Cognito's `PasswordType` allows (256
 * characters).
 *
 * @param field The operation's parameter name, for the message (`password`,
 *   `temporaryPassword`, `proposedPassword`).
 * @throws `InvalidParameterException`.
 * @internal
 */
export function enforcePasswordLength(password: string, field = 'password'): void {
	if (codePoints(password) > PASSWORD_MAX_LENGTH) {
		throw serviceError(
			AuthErrors.InvalidParameter,
			`1 validation error detected: Value at '${field}' failed to satisfy constraint: Member must have length less than or equal to ${PASSWORD_MAX_LENGTH}`,
		);
	}
}
