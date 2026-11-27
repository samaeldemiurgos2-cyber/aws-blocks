// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const GUARD = join(import.meta.dirname, 'check-packed-links.ts');
const REPO_ROOT = join(import.meta.dirname, '..');

function pkg(dir, manifest, files) {
	return {
		[`${dir}/package.json`]: JSON.stringify({ name: `@aws-cdk-blocks/${dir}`, version: '0.0.0', ...manifest }),
		...Object.fromEntries(Object.entries(files).map(([rel, content]) => [`${dir}/${rel}`, content])),
	};
}

function runGuard(files) {
	const dir = mkdtempSync(join(tmpdir(), 'packed-links-guard-'));
	try {
		for (const [rel, content] of Object.entries(files)) {
			const abs = join(dir, 'packages', rel);
			mkdirSync(join(abs, '..'), { recursive: true });
			writeFileSync(abs, content);
		}
		try {
			const stdout = execFileSync('npx', ['tsx', GUARD, '--root', dir], {
				cwd: REPO_ROOT,
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			return { code: 0, output: stdout };
		} catch (err) {
			return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('check-packed-links', () => {
	it('passes when every link target is packed', () => {
		const { code, output } = runGuard(
			pkg(
				'bb-realtime',
				{ files: ['README.md', 'USE-CASES.md', 'src'] },
				{
					'README.md': '[use cases](./USE-CASES.md#chat) [source](./src/) [entry](src/index.ts) [license](LICENSE)',
					'USE-CASES.md': '[back](README.md)',
					'src/index.ts': 'export {};',
					LICENSE: 'Apache-2.0',
				},
			),
		);
		assert.equal(code, 0, output);
		assert.match(output, /All 5 relative link\(s\)/);
	});

	it('fails when a BB README links a guide that "files" omits', () => {
		const { code, output } = runGuard(
			pkg(
				'bb-realtime',
				{ files: ['dist', 'README.md', 'DESIGN.md'] },
				{ 'README.md': 'See [use cases](./USE-CASES.md).', 'USE-CASES.md': '# Use cases' },
			),
		);
		assert.equal(code, 1, output);
		assert.match(output, /packages\/bb-realtime\/README\.md links to \.\/USE-CASES\.md, which the packed tarball does not contain/);
		assert.match(output, /Add the target to "files" in packages\/bb-realtime\/package\.json, or link to /);
		assert.match(output, /https:\/\/github\.com\/aws\/cdk-blocks\/blob\/main\/packages\/bb-realtime\/USE-CASES\.md/);
	});

	it('fails when the umbrella README links a guide that "files" omits', () => {
		const { code, output } = runGuard(
			pkg(
				'blocks',
				{ name: 'aws-cdk-blocks', files: ['dist', 'docs', 'README.md', 'IMPORTS.md'] },
				{
					'README.md': '[imports](./IMPORTS.md) [help](./TROUBLESHOOTING.md#deploy)',
					'IMPORTS.md': '# Imports',
					'TROUBLESHOOTING.md': '# Troubleshooting',
				},
			),
		);
		assert.equal(code, 1, output);
		assert.match(output, /packages\/blocks\/README\.md links to \.\/TROUBLESHOOTING\.md#deploy, which the packed tarball/);
		assert.doesNotMatch(output, /links to \.\/IMPORTS\.md/);
	});

	it('fails when .npmignore excludes a target that "files" seems to cover', () => {
		const { code, output } = runGuard(
			pkg(
				'bb-thing',
				{ files: ['README.md', 'guides'] },
				{
					'README.md': '[kept](guides/kept.md) [internal](guides/internal.md)',
					'guides/kept.md': '# Kept',
					'guides/internal.md': '# Internal',
					'guides/.npmignore': 'internal.md\n',
				},
			),
		);
		assert.equal(code, 1, output);
		assert.match(output, /packages\/bb-thing\/README\.md links to guides\/internal\.md, which the packed tarball/);
		assert.doesNotMatch(output, /links to guides\/kept\.md/);
	});

	it('accepts a link into a sibling package of the same scope, when the sibling packs the target', () => {
		const core = pkg('core', { files: ['README.md'] }, { 'README.md': '# Core', 'INTERNAL.md': '# Internal' });
		const passing = runGuard({
			...core,
			...pkg('bb-thing', { files: ['README.md'] }, { 'README.md': '[core](../core/README.md)' }),
		});
		assert.equal(passing.code, 0, passing.output);

		const failing = runGuard({
			...core,
			...pkg('bb-thing', { files: ['README.md'] }, { 'README.md': '[core](../core/INTERNAL.md)' }),
		});
		assert.equal(failing.code, 1, failing.output);
		assert.match(failing.output, /packages\/bb-thing\/README\.md links to \.\.\/core\/INTERNAL\.md, which the packed tarball/);
	});

	it('fails on a link that leaves the scope', () => {
		const { code, output } = runGuard({
			...pkg('core', { files: ['README.md'] }, { 'README.md': '[umbrella](../blocks/README.md)' }),
			...pkg('blocks', { name: 'aws-cdk-blocks', files: ['README.md'] }, { 'README.md': '[core](../core/README.md)' }),
			...pkg(
				'bb-thing',
				{ files: ['README.md'] },
				{ 'README.md': '[decisions](../../docs/DECISIONS.md#d-001) [tool](../internal/README.md)' },
			),
			...pkg('internal', { private: true }, { 'README.md': '# Internal' }),
		});
		assert.equal(code, 1, output);
		for (const [file, link] of [
			['core/README.md', '../blocks/README.md'],
			['blocks/README.md', '../core/README.md'],
			['bb-thing/README.md', '../../docs/DECISIONS.md#d-001'],
			['bb-thing/README.md', '../internal/README.md'],
		]) {
			assert.ok(
				output.includes(`packages/${file} links to ${link}, which is outside every package npm installs next to this one`),
				output,
			);
		}
		assert.ok(output.includes('. Link to https://github.com/aws/cdk-blocks/blob/main/docs/DECISIONS.md'), output);
		assert.doesNotMatch(output, /Add the target to "files"/);
	});

	it('ignores links in code, absolute URLs, pure anchors and CHANGELOG.md', () => {
		const { code, output } = runGuard(
			pkg(
				'bb-thing',
				{ files: ['README.md'] },
				{
					'README.md': [
						'[ok](./LICENSE) [web](https://example.com/GONE.md) [top](#top) `[inline](./GONE.md)`',
						'```md',
						'[fenced](./GONE.md)',
						'```',
					].join('\n'),
					'CHANGELOG.md': '[old](./GONE.md)',
					LICENSE: 'Apache-2.0',
				},
			),
		);
		assert.equal(code, 0, output);
		assert.match(output, /All 1 relative link\(s\)/);
	});

	it('fails on a dead link in packed Markdown below the package root', () => {
		const { code, output } = runGuard(
			pkg(
				'blocks',
				{ name: 'aws-cdk-blocks', files: ['README.md', 'docs'] },
				{ 'README.md': '[docs](./docs/)', 'docs/bb-thing.md': '[design](./DESIGN.md) [readme](../README.md)' },
			),
		);
		assert.equal(code, 1, output);
		assert.match(output, /packages\/blocks\/docs\/bb-thing\.md links to \.\/DESIGN\.md, which the packed tarball/);
		assert.doesNotMatch(output, /links to \.\.\/README\.md/);
	});

	it('skips private packages, which are never published', () => {
		const { code, output } = runGuard({
			...pkg('bb-thing', { files: ['README.md'] }, { 'README.md': '[license](LICENSE)', LICENSE: 'Apache-2.0' }),
			...pkg('internal', { private: true }, { 'README.md': '[gone](./GONE.md)' }),
		});
		assert.equal(code, 0, output);
		assert.doesNotMatch(output, /GONE/);
	});

	it('fails rather than passing when it finds no link to check', () => {
		const { code, output } = runGuard(pkg('bb-thing', { files: ['README.md'] }, { 'README.md': '# Thing' }));
		assert.equal(code, 1, output);
		assert.match(output, /found no relative link/);
	});
});
