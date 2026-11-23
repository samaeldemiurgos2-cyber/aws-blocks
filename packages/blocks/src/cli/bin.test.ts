// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
	bin: Record<string, string>;
};

/** The two ways a package script runs a task: the `cdk-blocks` bin, and the 1.0.0 `node -e` entry. */
const taskEntries: Record<string, string[]> = {
	'the cdk-blocks bin': [fileURLToPath(new URL(`../../${manifest.bin['cdk-blocks']}`, import.meta.url))],
	'the 1.0.0 package task entry': ['--input-type=module', '-e', `import 'aws-cdk-blocks/run'`, '--'],
};

describe('the bin map of aws-cdk-blocks', () => {
	it('installs the cdk-blocks command that package scripts run, and not the prerelease blocks command', () => {
		assert.strictEqual(manifest.bin['cdk-blocks'], './dist/cli/bin.js');
		assert.strictEqual(Object.hasOwn(manifest.bin, 'blocks'), false);
	});
});

for (const [label, taskEntry] of Object.entries(taskEntries)) {
	describe(label, () => {
		const run = async (args: string[]) => {
			const cli = spawn(process.execPath, [...taskEntry, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
			let stdout = '';
			let stderr = '';
			cli.stdout.on('data', (chunk) => (stdout += chunk));
			cli.stderr.on('data', (chunk) => (stderr += chunk));
			const code = await new Promise<number | null>((resolve) => cli.on('close', resolve));
			return { code, stdout, stderr };
		};

		it('exits 0 without a stack when its reader closes the pipe early, as `| head` does', async () => {
			// Far more than a pipe buffer holds, so the CLI is still writing when the reader goes away.
			const blocks = ['core', 'Auth', 'Realtime', 'FileBucket', 'KVStore', 'Database', 'Agent'];
			const cli = spawn(process.execPath, [...taskEntry, 'docs', ...blocks], {
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stderr = '';
			cli.stderr.on('data', (chunk) => (stderr += chunk));
			cli.stdout.once('data', () => cli.stdout.destroy());
			const code = await new Promise<number | null>((resolve) => cli.on('close', resolve));
			assert.strictEqual(code, 0, stderr);
			assert.doesNotMatch(stderr, /EPIPE|Unhandled/);
		});

		it('prints docs as JSON on a pipe unless Markdown is explicitly requested', async () => {
			const text = await run(['docs', 'KVStore', '--output', 'text']);
			assert.strictEqual(text.code, 0);
			assert.match(text.stdout, /^# bb-kv-store\/README\.md\b/);
			const json = await run(['docs', 'KVStore']);
			assert.strictEqual(json.code, 0);
			assert.strictEqual(JSON.parse(json.stdout).docs[0].doc, 'bb-kv-store/README.md');
		});

		it('passes the task arguments through and exits 2 for an unknown task', async () => {
			const unknown = await run(['deplyo']);
			assert.strictEqual(unknown.code, 2, unknown.stderr);
			assert.match(unknown.stderr, /deplyo/);
		});
	});
}
