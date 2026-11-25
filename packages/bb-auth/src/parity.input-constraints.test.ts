// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock ↔ AWS parity for **Cognito's input constraints on a username and a
 * password**: the `UsernameType` (length 1–128, pattern
 * `[\p{L}\p{M}\p{S}\p{N}\p{P}]+`) and `PasswordType` (at most 256 characters)
 * shapes of the `cognito-idp` service model. Cognito refuses a value outside
 * them with `InvalidParameterException` before it looks at the user, so the
 * local engine (`./index.mock.js`) does the same, and stores nothing; on the
 * AWS entry (`./index.aws.js`, offline through `test-support/aws-harness.ts`)
 * the harness answers as Cognito does. Both reach the client as the same 400.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { ScopeParent } from '@aws-cdk-blocks/core';
import { AuthErrors } from './errors.js';
import { Auth as MockAuth } from './index.mock.js';
import { Browser as AwsBrowser, cognitoError, makeAwsAuth, signInAs, wireView } from './test-support/aws-harness.js';
import { Browser } from './test-helpers.js';
import type { CodeDeliveryPurpose } from './types.js';

beforeEach(() => rmSync('.cdk-blocks/local/data', { recursive: true, force: true }));
afterEach(() => rmSync('.cdk-blocks/local/data', { recursive: true, force: true }));

const GOOD = 'Passw0rd!long';
/** 300 characters that meet the default policy. */
const LONG_PASSWORD = `Aa1!${'x'.repeat(296)}`;
/** Exactly Cognito's maximum. */
const MAX_PASSWORD = `Aa1!${'x'.repeat(252)}`;
const OPTIONS = { admin: { actions: ['lifecycle'] } } as const;
let n = 0;
const root = (): ScopeParent => ({ id: `parityinput${process.pid}x${++n}` });

const failure = (p: Promise<unknown>) =>
	p.then(
		() => assert.fail('expected the input to be rejected'),
		(e: unknown) => wireView(e),
	);

/** A local `Auth` that records the codes it delivers. */
function localAuth() {
	const codes: { purpose: CodeDeliveryPurpose; code: string }[] = [];
	const auth = new MockAuth(root(), 'auth', {
		...OPTIONS,
		codeDelivery: async (_u: string, code: string, purpose: CodeDeliveryPurpose) => {
			codes.push({ purpose, code });
		},
	});
	const last = (purpose: CodeDeliveryPurpose) => [...codes].reverse().find((c) => c.purpose === purpose)?.code ?? '';
	return { auth, last };
}

/** The AWS entry, with Cognito answering `command` with a model-validation error. */
function awsRefusing(command: string) {
	const h = makeAwsAuth(OPTIONS);
	h.on(command, () => {
		throw cognitoError(
			'InvalidParameterException',
			"1 validation error detected: Value at 'username' failed to satisfy constraint: Member must satisfy regular expression pattern: [\\p{L}\\p{M}\\p{S}\\p{N}\\p{P}]+",
		);
	});
	return h.auth;
}

const BAD_USERNAMES: { label: string; username: string }[] = [
	{ label: 'empty', username: '' },
	{ label: 'a single space', username: ' ' },
	{ label: 'an inner space', username: 'has space' },
	{ label: 'a tab', username: 'tab\there' },
	{ label: 'a newline', username: 'new\nline' },
	{ label: 'a NUL character', username: 'nul\u0000char' },
	{ label: 'a no-break space', username: 'no\u00a0break' },
	{ label: '129 characters', username: 'a'.repeat(129) },
	{ label: '200 characters', username: 'a'.repeat(200) },
];

describe('parity: a username outside Cognito’s UsernameType is refused', () => {
	for (const { label, username } of BAD_USERNAMES) {
		test(`signUp, ${label}`, async () => {
			const local = localAuth();
			const mock = await failure(local.auth.signUp(username, GOOD));
			const aws = await failure(awsRefusing('SignUpCommand').signUp(username, GOOD));

			assert.deepStrictEqual(mock, aws, 'same name, status, retriable and message');
			assert.strictEqual(mock.name, AuthErrors.InvalidParameter);
			assert.strictEqual(mock.code, 400);
			assert.strictEqual(await local.auth.admin.getUser(username), null, 'nothing stored');
		});

		test(`admin.createUser, ${label}`, async () => {
			const local = localAuth();
			const mock = await failure(local.auth.admin.createUser(username));
			const aws = await failure(awsRefusing('AdminCreateUserCommand').admin.createUser(username));

			assert.deepStrictEqual(mock, aws);
			assert.strictEqual(mock.name, AuthErrors.InvalidParameter);
			assert.strictEqual(await local.auth.admin.getUser(username), null, 'nothing stored');
		});
	}

	test('an empty username stays refused on retry: nothing was stored the first time', async () => {
		const { auth } = localAuth();
		const first = await failure(auth.signUp('', GOOD));
		const second = await failure(auth.signUp('', GOOD));
		assert.strictEqual(first.name, AuthErrors.InvalidParameter);
		assert.deepStrictEqual(second, first, 'not UsernameExistsException');
	});

	test('the edges Cognito accepts are accepted: 128 characters, letters, marks, symbols, punctuation', async () => {
		const { auth } = localAuth();
		for (const username of ['a'.repeat(128), 'zoë_ü.-+', 'naïve\u0301', '日本語', 'x$€!']) {
			await auth.signUp(username, GOOD);
			assert.ok(await auth.admin.getUser(username), username);
		}
	});
});

describe('parity: a password over Cognito’s 256 characters is refused', () => {
	test('signUp', async () => {
		const local = localAuth();
		const mock = await failure(local.auth.signUp('alice', LONG_PASSWORD));
		const aws = await failure(awsRefusing('SignUpCommand').signUp('alice', LONG_PASSWORD));

		assert.deepStrictEqual(mock, aws);
		assert.strictEqual(mock.name, AuthErrors.InvalidParameter);
		assert.strictEqual(await local.auth.admin.getUser('alice'), null, 'nothing stored');
	});

	test('signUp accepts exactly 256 characters', async () => {
		const { auth } = localAuth();
		await auth.signUp('alice', MAX_PASSWORD);
		assert.ok(await auth.admin.getUser('alice'));
	});

	test('admin.createUser with a temporary password', async () => {
		const local = localAuth();
		const mock = await failure(local.auth.admin.createUser('alice', { temporaryPassword: LONG_PASSWORD }));
		const aws = await failure(
			awsRefusing('AdminCreateUserCommand').admin.createUser('alice', { temporaryPassword: LONG_PASSWORD }),
		);

		assert.deepStrictEqual(mock, aws);
		assert.strictEqual(await local.auth.admin.getUser('alice'), null, 'nothing stored');
	});

	test('admin.setUserPassword', async () => {
		const local = localAuth();
		await local.auth.admin.createUser('alice');
		const mock = await failure(local.auth.admin.setUserPassword('alice', LONG_PASSWORD, { permanent: true }));
		const aws = await failure(
			awsRefusing('AdminSetUserPasswordCommand').admin.setUserPassword('alice', LONG_PASSWORD, {
				permanent: true,
			}),
		);

		assert.deepStrictEqual(mock, aws);
		assert.strictEqual(mock.name, AuthErrors.InvalidParameter);
	});

	test('confirmResetPassword', async () => {
		const local = localAuth();
		await local.auth.signUp('alice', GOOD, { attributes: { email: 'alice@example.com' } });
		await local.auth.confirmSignUp('alice', local.last('signUp'));
		await local.auth.resetPassword('alice');
		const mock = await failure(
			local.auth.confirmResetPassword('alice', local.last('resetPassword'), LONG_PASSWORD),
		);
		const aws = await failure(
			awsRefusing('ConfirmForgotPasswordCommand').confirmResetPassword('alice', '123456', LONG_PASSWORD),
		);

		assert.deepStrictEqual(mock, aws);
		assert.strictEqual(mock.name, AuthErrors.InvalidParameter);
	});

	/** `updatePassword` from a signed-in session on each runtime; AWS refuses `ChangePassword`. */
	async function updatePasswordOnBoth(oldPassword: string, newPassword: string) {
		const local = localAuth();
		await local.auth.signUp('alice', GOOD, { attributes: { email: 'alice@example.com' } });
		await local.auth.confirmSignUp('alice', local.last('signUp'));
		const b = new Browser();
		await b.request((ctx) => local.auth.signIn('alice', GOOD, ctx));
		const mock = await failure(b.request((ctx) => local.auth.updatePassword(ctx, oldPassword, newPassword)));

		const h = makeAwsAuth(OPTIONS);
		const ab = new AwsBrowser();
		await signInAs(h, ab, 'alice');
		h.on('ChangePasswordCommand', () => {
			throw cognitoError(
				'InvalidParameterException',
				"1 validation error detected: Value at 'proposedPassword' failed to satisfy constraint: Member must have length less than or equal to 256",
			);
		});
		const aws = await failure(ab.request((ctx) => h.auth.updatePassword(ctx, oldPassword, newPassword)));
		return { mock, aws };
	}

	test('updatePassword, a new password over 256 characters', async () => {
		const { mock, aws } = await updatePasswordOnBoth(GOOD, LONG_PASSWORD);
		assert.deepStrictEqual(mock, aws);
		assert.strictEqual(mock.name, AuthErrors.InvalidParameter);
	});

	test('updatePassword, an old password over 256 characters: refused before the comparison', async () => {
		// Cognito length-checks `PreviousPassword` first: InvalidParameter, not NotAuthorized.
		const { mock, aws } = await updatePasswordOnBoth(LONG_PASSWORD, `${GOOD}2`);
		assert.deepStrictEqual(mock, aws);
		assert.strictEqual(mock.name, AuthErrors.InvalidParameter);
	});
});
