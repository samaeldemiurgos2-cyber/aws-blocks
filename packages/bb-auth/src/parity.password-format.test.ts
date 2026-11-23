// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock ↔ AWS parity for **a password that begins or ends with whitespace,
 * or contains a line break**.
 * Cognito's `Password` / `ProposedPassword` / `TemporaryPassword` members
 * (`SignUp`, `ConfirmForgotPassword`, `ChangePassword`, `AdminSetUserPassword`,
 * `AdminCreateUser`) must match `^[\S]+.*[\S]+$`, so Cognito answers such a
 * request with `InvalidParameterException`. The local engine
 * (`./index.mock.js`) answers the same, instead of storing the password;
 * the AWS entry (`./index.aws.js`, offline through
 * `test-support/aws-harness.ts`) passes Cognito's answer through.
 * Whitespace inside a password stays allowed on both.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { ScopeParent } from '@aws-cdk-blocks/core';
import { AuthErrors } from './errors.js';
import { Auth as MockAuth } from './index.mock.js';
import { Browser } from './test-helpers.js';
import { cognitoError, makeAwsAuth, wireView } from './test-support/aws-harness.js';
import type { CodeDeliveryPurpose, CognitoAuthOptions } from './types.js';

beforeEach(() => rmSync('.cdk-blocks/local/data', { recursive: true, force: true }));
afterEach(() => rmSync('.cdk-blocks/local/data', { recursive: true, force: true }));

const GOOD = 'Passw0rd!long';
/** Cognito's answer for a `Password` member outside its pattern. */
const COGNITO_TEXT =
	"1 validation error detected: Value at 'password' failed to satisfy constraint: Member must satisfy regular expression pattern: ^[\\S]+.*[\\S]+$";
/**
 * Each would pass the default policy if it were not for the whitespace at an
 * end, or the line break inside (which Cognito's `.` does not match).
 */
const REFUSED = [
	` ${GOOD}`,
	`${GOOD} `,
	`\t${GOOD}`,
	`${GOOD}\n`,
	'Passw0rd\n!long',
	'Passw0rd\r!long',
	'Passw0rd\r\n!long',
];
let n = 0;
const root = (): ScopeParent => ({ id: `paritypwfmt${process.pid}x${++n}` });

const failure = (p: Promise<unknown>) =>
	p.then(
		() => assert.fail('expected the password to be rejected'),
		(e: unknown) => wireView(e),
	);

/** A local `Auth` that records the codes it delivers. */
function localAuth(options: CognitoAuthOptions = {}) {
	const codes: { purpose: CodeDeliveryPurpose; code: string }[] = [];
	const auth: MockAuth = new MockAuth(root(), 'auth', {
		...options,
		codeDelivery: async (_u: string, code: string, purpose: CodeDeliveryPurpose) => {
			codes.push({ purpose, code });
		},
	});
	const last = (purpose: CodeDeliveryPurpose) => [...codes].reverse().find((c) => c.purpose === purpose)?.code ?? '';
	return { auth, last };
}

describe('parity: a password with whitespace at an end or a line break inside is an invalid parameter', () => {
	for (const password of REFUSED) {
		test(`signUp with ${JSON.stringify(password)}`, async () => {
			const local = localAuth();
			const mock = await failure(local.auth.signUp('alice', password));

			const h = makeAwsAuth({});
			h.on('SignUpCommand', () => {
				throw cognitoError('InvalidParameterException', COGNITO_TEXT);
			});
			const wide: MockAuth = h.auth;
			const aws = await failure(wide.signUp('alice', password));

			assert.deepStrictEqual(mock, aws, 'same name, status, retriable and message');
			assert.strictEqual(mock.name, AuthErrors.InvalidParameter);
			// Nothing was stored: the same username signs up with a valid password.
			const later = await local.auth.signUp('alice', GOOD, { attributes: { email: 'alice@example.com' } });
			assert.strictEqual(later.isSignUpComplete, false);
		});
	}

	test('confirmResetPassword', async () => {
		const local = localAuth();
		await local.auth.signUp('alice', GOOD, { attributes: { email: 'alice@example.com' } });
		await local.auth.confirmSignUp('alice', local.last('signUp'));
		await local.auth.resetPassword('alice');
		const code = local.last('resetPassword');
		const mock = await failure(local.auth.confirmResetPassword('alice', code, ` ${GOOD}`));

		const h = makeAwsAuth({});
		h.on('ConfirmForgotPasswordCommand', () => {
			throw cognitoError('InvalidParameterException', COGNITO_TEXT);
		});
		const wide: MockAuth = h.auth;
		const aws = await failure(wide.confirmResetPassword('alice', '123456', ` ${GOOD}`));

		assert.deepStrictEqual(mock, aws);
		assert.strictEqual(mock.name, AuthErrors.InvalidParameter);
		// The stored password is unchanged, and the code was not spent.
		assert.strictEqual(
			(await new Browser().request((ctx) => local.auth.signIn('alice', GOOD, ctx))).status,
			'signedIn',
		);
		await local.auth.confirmResetPassword('alice', code, `${GOOD}2`);
	});
});

describe('local engine: the format rule on every password Cognito patterns', () => {
	test('updatePassword refuses the new password and keeps the old one', async () => {
		const local = localAuth();
		await local.auth.signUp('bob', GOOD, { attributes: { email: 'bob@example.com' } });
		await local.auth.confirmSignUp('bob', local.last('signUp'));
		const b = new Browser();
		await b.request((ctx) => local.auth.signIn('bob', GOOD, ctx));
		const e = await failure(b.request((ctx) => local.auth.updatePassword(ctx, GOOD, `${GOOD} `)));
		assert.strictEqual(e.name, AuthErrors.InvalidParameter);
		const inner = await failure(b.request((ctx) => local.auth.updatePassword(ctx, GOOD, 'Passw0rd\n!long')));
		assert.strictEqual(inner.name, AuthErrors.InvalidParameter);
		assert.strictEqual(
			(await new Browser().request((ctx) => local.auth.signIn('bob', GOOD, ctx))).status,
			'signedIn',
		);
	});

	test('admin createUser and setUserPassword refuse it', async () => {
		const auth = new MockAuth(root(), 'auth', { admin: {} });
		const created = await failure(auth.admin.createUser('carol', { temporaryPassword: ` ${GOOD}` }));
		assert.strictEqual(created.name, AuthErrors.InvalidParameter);
		// Nothing was created.
		assert.strictEqual(await auth.admin.getUser('carol'), null);

		await auth.admin.createUser('carol', { temporaryPassword: GOOD });
		const set = await failure(auth.admin.setUserPassword('carol', `${GOOD}\t`, { permanent: true }));
		assert.strictEqual(set.name, AuthErrors.InvalidParameter);
		// The stored (temporary) password is unchanged: it still opens the new-password challenge.
		const r = await new Browser().request((ctx) => auth.signIn('carol', GOOD, ctx));
		assert.ok(r.status === 'continueSignIn' && r.nextStep.name === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED');
	});

	test('updatePassword refuses an old password in that format, before the comparison', async () => {
		const local = localAuth();
		await local.auth.signUp('fay', GOOD, { attributes: { email: 'fay@example.com' } });
		await local.auth.confirmSignUp('fay', local.last('signUp'));
		const b = new Browser();
		await b.request((ctx) => local.auth.signIn('fay', GOOD, ctx));
		// Cognito checks `PreviousPassword`'s format first: InvalidParameter, not NotAuthorized.
		const e = await failure(b.request((ctx) => local.auth.updatePassword(ctx, ` ${GOOD}`, `${GOOD}2`)));
		assert.strictEqual(e.name, AuthErrors.InvalidParameter);
	});

	test('other whitespace inside a password is allowed', async () => {
		const local = localAuth();
		for (const [i, inner] of ['Correct Horse 1!', 'Correct\tHorse 1!', 'Correct\u2028Horse 1!'].entries()) {
			const name = `dave${i}`;
			await local.auth.signUp(name, inner, { attributes: { email: `${name}@example.com` } });
			await local.auth.confirmSignUp(name, local.last('signUp'));
			assert.strictEqual(
				(await new Browser().request((ctx) => local.auth.signIn(name, inner, ctx))).status,
				'signedIn',
				JSON.stringify(inner),
			);
		}
	});

	test('a non-ASCII space is not whitespace to Cognito’s validator', async () => {
		const local = localAuth();
		const r = await local.auth.signUp('erin', `\u00a0${GOOD}`, { attributes: { email: 'erin@example.com' } });
		assert.strictEqual(r.isSignUpComplete, false);
	});
});
