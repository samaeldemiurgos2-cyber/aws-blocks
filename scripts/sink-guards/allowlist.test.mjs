// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// compareWithAllowlist, which every sink guard uses: an entry names a site by
// file, enclosing function and full code, so edits elsewhere in a file don't
// break it, and a reviewed site can't be swapped for an unreviewed one.
//
// Run: node --test scripts/sink-guards/allowlist.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareWithAllowlist, findShellSinks, report } from './sinks.mjs';

const REASON = 'A reason long enough to count as written.';
const IMPORT = "import { execFileSync } from 'node:child_process';\n";
const VIEW = "function view(name: string) { return execFileSync('npm', ['view', name], { shell: isWin }); }\n";
const VIEW_SITE = "execFileSync('npm', ['view', name], { shell: isWin })";

const sites = (src) => findShellSinks('a.ts', IMPORT + src);
const entry = (site, scope = 'view', at = 'a.ts') => ({ at, in: scope, site, reason: REASON });
const compare = (src, allowlist) => compareWithAllowlist(sites(src), allowlist);
const clean = { unexpected: [], stale: [] };

describe('compareWithAllowlist', () => {
	it('names a shell: option by its whole call and enclosing function', () => {
		assert.deepEqual(
			sites(VIEW).map((f) => [f.in, f.code]),
			[['view', VIEW_SITE]],
		);
	});

	it('matches a site whatever its line', () => {
		for (const src of [VIEW, `// one\n// two\n${VIEW}`, `function other() {}\n${VIEW}`]) {
			assert.deepEqual(compare(src, [entry(VIEW_SITE)]), clean);
		}
	});

	it('reports a reviewed site swapped for an identical one in another function', () => {
		// The reviewed call no longer uses a shell; a copy appears elsewhere.
		const src = `${VIEW.replace('shell: isWin', 'shell: false')}function run(name: string) { return execFileSync('npm', ['view', name], { shell: isWin }); }\n`;
		const result = compare(src, [entry(VIEW_SITE)]);
		assert.deepEqual(result.unexpected.map((f) => f.in), ['run']);
		assert.deepEqual(result.stale.map((e) => e.in), ['view']);
	});

	it('reports a change to the argv of an allowlisted shell: option call', () => {
		const result = compare(VIEW.replace("['view', name]", "['exec', name]"), [entry(VIEW_SITE)]);
		assert.equal(result.unexpected.length, 1);
		assert.equal(result.stale.length, 1);
	});

	it('matches the full code, not its first 120 characters', () => {
		const pad = 'x'.repeat(130);
		const long = `function view(name: string) { return execFileSync('npm', ['${pad}', name], { shell: isWin }); }\n`;
		const [site] = sites(long);
		assert.ok(site.text.length < site.code.length, 'the display text is cut');
		assert.deepEqual(compare(long, [entry(site.code)]), clean);
		// An edit past the cut is a different site.
		const edited = compare(long.replace('name]', 'name, extra]'), [entry(site.code)]);
		assert.equal(edited.unexpected.length, 1);
		assert.equal(edited.stale.length, 1);
	});

	it('needs the exact code: an entry that is a prefix of the site does not match', () => {
		const src = "function view(name: string) { return execFileSync('npm', ['view', name], { shell: isWindows() }); }\n";
		const result = compare(src, [entry("execFileSync('npm', ['view', name], { shell: isWin")]);
		assert.equal(result.unexpected.length, 1);
		assert.equal(result.stale.length, 1);
	});

	it('keys by file: the same code in another file is not allowed', () => {
		const result = compare(VIEW, [entry(VIEW_SITE, 'view', 'b.ts')]);
		assert.equal(result.unexpected.length, 1);
		assert.equal(result.stale.length, 1);
	});

	it('needs one entry per identical site, so a copy is still reported', () => {
		const twice = `function view(name: string) {\n\texecFileSync('npm', ['view', name], { shell: isWin });\n\texecFileSync('npm', ['view', name], { shell: isWin });\n}\n`;
		assert.deepEqual(compare(twice, [entry(VIEW_SITE), entry(VIEW_SITE)]), clean);
		assert.deepEqual(
			compare(twice, [entry(VIEW_SITE)]).unexpected.map((f) => f.line),
			[4],
		);
		assert.equal(compare(twice, [entry(VIEW_SITE), entry(VIEW_SITE), entry(VIEW_SITE)]).stale.length, 1);
	});

	it('names a site outside any function `(top level)`, and skips anonymous callbacks', () => {
		const src = "execFileSync('npm', [x], { shell: true });\nfunction outer() { [1].forEach(() => execFileSync('npm', [x], { shell: true })); }\n";
		assert.deepEqual(
			sites(src).map((f) => f.in),
			['(top level)', 'outer'],
		);
	});

	it('rejects a file:line entry, a missing site, an empty in and a missing reason', () => {
		assert.throws(() => compareWithAllowlist([], [entry('x', 'view', 'a.ts:12')]), /must be a file path/);
		assert.throws(() => compareWithAllowlist([], [{ at: 'a.ts', reason: REASON }]), /needs the site's code/);
		assert.throws(() => compareWithAllowlist([], [{ at: 'a.ts', in: '', site: 'x', reason: REASON }]), /`in` must be/);
		assert.throws(() => compareWithAllowlist([], [{ at: 'a.ts', site: 'x', reason: 'short' }]), /needs a written reason/);
	});

	it('reports an unexpected site with the entry that would allow it', () => {
		const text = report('shell', compare(VIEW, []));
		assert.match(text, /a\.ts:2 {2}\[shell-option\] {2}in view {2}execFileSync/);
		assert.ok(text.includes(`allow with: { at: "a.ts", in: "view", site: ${JSON.stringify(VIEW_SITE)}, reason: '…' }`), text);
	});
});
