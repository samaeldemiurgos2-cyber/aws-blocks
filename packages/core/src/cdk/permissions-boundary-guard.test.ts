// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { assertEveryRoleBoundedAndReported, GUARD_BOUNDARY } from './permissions-boundary-guard.js';

const REPORT = 'App.blocks-iam.json';
const BOUNDED = {
	'Fn::Join': [
		'',
		['arn:', { Ref: 'AWS::Partition' }, ':iam::', { Ref: 'AWS::AccountId' }, `:policy/${GUARD_BOUNDARY}`],
	],
};

type Role = { artifact: string; logicalId: string; boundary?: unknown; reported: boolean };

describe('assertEveryRoleBoundedAndReported', () => {
	let outdir: string;
	beforeEach(() => {
		outdir = mkdtempSync(join(tmpdir(), 'boundary-guard-'));
	});
	afterEach(() => {
		rmSync(outdir, { recursive: true, force: true });
	});

	function writeAssembly(roles: Role[]): void {
		for (const artifact of new Set(roles.map((r) => r.artifact))) {
			const Resources: Record<string, unknown> = { Bucket: { Type: 'AWS::S3::Bucket' } };
			for (const r of roles.filter((r) => r.artifact === artifact)) {
				Resources[r.logicalId] = {
					Type: 'AWS::IAM::Role',
					Properties: r.boundary === undefined ? {} : { PermissionsBoundary: r.boundary },
				};
			}
			writeFileSync(join(outdir, `${artifact}.template.json`), JSON.stringify({ Resources }));
		}
		const reported = roles.filter((r) => r.reported).map((r) => ({ stack: r.artifact, logicalId: r.logicalId }));
		writeFileSync(join(outdir, REPORT), JSON.stringify({ roles: reported }));
	}

	test('passes and returns every role when each carries the boundary and is in the report', () => {
		writeAssembly([
			{ artifact: 'App', logicalId: 'ExecRole', boundary: BOUNDED, reported: true },
			{ artifact: 'Helper', logicalId: 'ProviderRole', boundary: BOUNDED, reported: true },
		]);
		assert.deepStrictEqual(assertEveryRoleBoundedAndReported(outdir, REPORT).sort(), [
			'App/ExecRole',
			'Helper/ProviderRole',
		]);
	});

	test('fails naming <artifact>/<logicalId> for a role without the boundary', () => {
		writeAssembly([
			{ artifact: 'App', logicalId: 'ExecRole', boundary: BOUNDED, reported: true },
			{ artifact: 'Helper', logicalId: 'ProviderRole', reported: true },
		]);
		assert.throws(() => assertEveryRoleBoundedAndReported(outdir, REPORT), /Helper\/ProviderRole: boundary "NONE"/);
	});

	test('fails naming the role when it carries a different boundary', () => {
		writeAssembly([
			{ artifact: 'App', logicalId: 'ExecRole', boundary: 'arn:aws:iam::1:policy/other', reported: true },
		]);
		assert.throws(
			() => assertEveryRoleBoundedAndReported(outdir, REPORT),
			/App\/ExecRole: boundary "arn:aws:iam::1:policy\/other"/,
		);
	});

	test('fails naming a bounded role that is missing from the report', () => {
		writeAssembly([
			{ artifact: 'App', logicalId: 'ExecRole', boundary: BOUNDED, reported: true },
			{ artifact: 'Helper', logicalId: 'ProviderRole', boundary: BOUNDED, reported: false },
		]);
		assert.throws(
			() => assertEveryRoleBoundedAndReported(outdir, REPORT),
			/Helper\/ProviderRole: missing from App\.blocks-iam\.json/,
		);
	});

	test('fails when the assembly holds no role at all', () => {
		writeAssembly([]);
		assert.throws(() => assertEveryRoleBoundedAndReported(outdir, REPORT), /at least one role/);
	});

	test('fails on a nested assembly, whose templates it does not read', () => {
		writeAssembly([{ artifact: 'App', logicalId: 'ExecRole', boundary: BOUNDED, reported: true }]);
		mkdirSync(join(outdir, 'assembly-Prod'));
		assert.throws(() => assertEveryRoleBoundedAndReported(outdir, REPORT), /templates of a CDK Stage are not read/);
	});
});
