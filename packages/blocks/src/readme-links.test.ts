// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * No tracked Markdown or TypeScript file of the repository may keep a merge
 * conflict marker: a rebase that leaves one in a README ships both sides of the
 * conflict to npm, and nothing else in `npm test` reads the docs.
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Compiled to dist/, so the package root is one level up.
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));

/** The 1-based line numbers of the merge conflict marker lines in `text`. */
function conflictMarkerLines(text: string): number[] {
	const lines: number[] = [];
	text.split(/\r?\n/).forEach((line, i) => {
		if (/^(<{7}|>{7})/.test(line) || line === '='.repeat(7)) lines.push(i + 1);
	});
	return lines;
}

test('conflictMarkerLines finds the three marker lines of a conflict block', () => {
	const block = [
		'intro',
		`${'<'.repeat(7)} HEAD`,
		'ours',
		'='.repeat(7),
		'theirs',
		`${'>'.repeat(7)} 383255bf (fix: something)`,
		'===',
		'a <<<<<<< inline mention',
	].join('\n');
	assert.deepStrictEqual(conflictMarkerLines(block), [2, 4, 6]);
});

test('no tracked Markdown or TypeScript file keeps a merge conflict marker', (t) => {
	let files: string[];
	let root: string;
	try {
		root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: pkgRoot, encoding: 'utf-8' }).trim();
		files = execFileSync('git', ['ls-files', '-z', '--', '*.md', '*.mdx', '*.ts', '*.mts', '*.cts', '*.tsx'], {
			cwd: root,
			encoding: 'utf-8',
			maxBuffer: 64 * 1024 * 1024,
		})
			.split('\0')
			.filter(Boolean);
	} catch {
		t.skip('not in a git checkout');
		return;
	}
	const found: string[] = [];
	for (const file of files) {
		const path = join(root, file);
		if (!existsSync(path)) continue; // deleted in the working tree, not yet staged
		for (const line of conflictMarkerLines(readFileSync(path, 'utf-8'))) found.push(`${file}:${line}`);
	}
	assert.deepStrictEqual(found, [], `merge conflict markers left in:\n  ${found.join('\n  ')}`);
});
