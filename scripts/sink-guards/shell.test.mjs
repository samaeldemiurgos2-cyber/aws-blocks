// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Repo invariant: no value is interpolated into a shell command line. Run
// programs with an argv array (`execFileSync(file, args)`, `spawn(file, args)`)
// and no shell; `exec`/`execSync` take only a constant command string; a shell
// program started through argv (`sh -c`, `cmd /c`, `powershell -Command`) gets
// only constants after its command flag; and an options object never sets
// `shell` to anything but `false` (a `const` options object is resolved, and a
// spread the scan can't see into is reported). A value that must reach a shell
// is validated against a strict allowlist first, and the site is listed below
// with that reason.
//
// The scan follows `child_process` imports within one file. A shell reached
// through a wrapper in another module, or an options object built at run time,
// is outside what it can see; route those through the wrappers above instead.
//
// Scans every tracked production TypeScript/JavaScript file (tests excluded) on
// the TypeScript AST. Allowlist entries name a site by file, enclosing function
// (`in`) and full code (`site`), as the failure report prints them, not by
// line, with a reason; an entry that stops matching a site fails the test, so
// the list only shrinks.
//
// Run: node --test scripts/sink-guards/shell.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareWithAllowlist, findShellSinks, listSourceFiles, report, scan } from './sinks.mjs';

const LSOF_CLEANUP =
	'Ports come from a literal list in this file and each pid is a line of `lsof -t` output (digits); no outside value reaches the command.';
const WINDOWS_NPM =
	'shell only on Windows, where npm is an npm.cmd shim that execFileSync cannot start without one; the argv is fixed or validated (validateScope) first.';
const CI_WINDOWS =
	"CI driver: shell only on Windows for the npm/npx .cmd shims; every argument is a constant or a path the driver creates, and the spread options come from the driver's own calls (cwd/env).";
const APP_COMMAND =
	"Runs the app's own configured command (the developer's package.json / defineHosting() config) by design; it has the trust of the app's own code.";

const ALLOWLIST = [
	{ at: 'native/kotlin/example/typescript/cdk-blocks/scripts/cleanup.ts', in: '(top level)', site: "execSync(`lsof -ti:${port}`, { encoding: 'utf-8' })", reason: LSOF_CLEANUP },
	{ at: 'native/kotlin/example/typescript/cdk-blocks/scripts/cleanup.ts', in: '(top level)', site: 'execSync(`kill ${pid}`)', reason: LSOF_CLEANUP },
	{ at: 'native/swift/Demo/typescript-demo/cdk-blocks/scripts/cleanup.ts', in: '(top level)', site: "execSync(`lsof -ti:${port}`, { encoding: 'utf-8' })", reason: LSOF_CLEANUP },
	{ at: 'native/swift/Demo/typescript-demo/cdk-blocks/scripts/cleanup.ts', in: '(top level)', site: 'execSync(`kill ${pid}`)', reason: LSOF_CLEANUP },
	{ at: 'packages/core/src/scripts/cleanup.ts', in: 'cleanup', site: "execSync(`lsof -ti:${port}`, { encoding: 'utf-8' })", reason: LSOF_CLEANUP },
	{ at: 'packages/core/src/scripts/cleanup.ts', in: 'cleanup', site: 'execSync(`kill ${pid}`)', reason: LSOF_CLEANUP },
	{ at: 'test-apps/native-bindings/cdk-blocks/scripts/cleanup.ts', in: '(top level)', site: "execSync(`lsof -ti:${port}`, { encoding: 'utf-8' })", reason: LSOF_CLEANUP },
	{ at: 'test-apps/native-bindings/cdk-blocks/scripts/cleanup.ts', in: '(top level)', site: 'execSync(`kill ${pid}`)', reason: LSOF_CLEANUP },
	{ at: 'packages/core/src/hosting.ts', in: 'Hosting.constructor', site: "execSync(props.buildCommand, { cwd: root, stdio: 'inherit', env: buildEnv, })", reason: `Hosting buildCommand. ${APP_COMMAND}` },
	{ at: 'packages/core/src/scripts/dev-server.ts', in: 'startDevServer.spawnFrontend', site: "spawn(command, { shell: true, // Own process group on POSIX so we can reap the Vite grandchild too. detached: usePosixProcessGroups, stdio: ['ignore', 'pipe', 'pipe'], env: frontendEnv(process.env, blocksConfig), })", reason: `Frontend dev command. ${APP_COMMAND}` },
	{
		at: 'packages/core/src/scripts/run-command.ts', in: 'spawnShellCommand', site: 'spawn(commandLine, [], { ...options, shell: true })',
		reason: `spawnShellCommand, whose only caller is the sandbox dev-server command. ${APP_COMMAND}`,
	},
	{
		at: 'packages/core/src/scripts/process-tree.ts', in: 'windowsProcessesAsync', site: "execFile( 'powershell.exe', windowsProcessQuery(pids), { encoding: 'utf-8', windowsHide: true, timeout: CIM_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (_error, stdout) => resolve(parseWindowsProcesses(stdout ?? '')), )",
		reason: 'CIM query of Windows processes: the only interpolated values are pids through Math.trunc into a fixed Get-CimInstance -Filter template, run with -NoProfile -NonInteractive and an argv array.',
	},
	{ at: 'packages/create-block/src/index.ts', in: 'resolvePublishedRange', site: "execFileSync('npm', ['view', pkgName, 'version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32', })", reason: `npm view of an @aws-cdk-blocks/* name: ${WINDOWS_NPM}` },
	{ at: 'packages/create-block/src/index.ts', in: 'verify', site: "execFileSync('npm', ['run', 'build', '-w', pkgName], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', })", reason: `npm run build -w <validated name>: ${WINDOWS_NPM}` },
	{ at: 'packages/create-block/src/index.ts', in: 'verify', site: "execFileSync('npm', ['test', '-w', pkgName], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', })", reason: `npm test -w <validated name>: ${WINDOWS_NPM}` },
	{ at: 'scripts/ci/_proc.mjs', in: 'runSpawn', site: "spawnSync(cmd, args, { stdio: 'inherit', shell: isWin, ...opts })", reason: CI_WINDOWS },
	{ at: 'scripts/ci/_proc.mjs', in: 'runSpawn', site: "spawnSync(cmd, args, { stdio: 'inherit', shell: isWin, ...opts })", reason: CI_WINDOWS },
	{ at: 'scripts/ci/windows-template-e2e.mjs', in: 'startUntilReady', site: "spawn(cmd, args, { shell: isWin, detached: !isWin, stdio: 'inherit', ...opts })", reason: CI_WINDOWS },
	{ at: 'scripts/ci/windows-template-e2e.mjs', in: 'startUntilReady', site: "spawn(cmd, args, { shell: isWin, detached: !isWin, stdio: 'inherit', ...opts })", reason: CI_WINDOWS },
	{
		at: 'scripts/agent-bench/steps/4-judge.ts', in: 'assertNoSpecLeak', site: "execSync( `find ${shellQuote(dir)} \\\\( -name bench-tests -o -regextype posix-extended -regex '.*\\\\.spec\\\\.[cm]?[jt]sx?$' \\\\) -print`, { encoding: 'utf-8' }, )",
		reason: 'The only value is the judge copy directory, passed through shellQuote() (single-quoted, embedded quotes escaped).',
	},
	{
		at: 'scripts/agent-bench/steps/4-judge.ts', in: 'collectBlocksImports', site: 'execSync( `grep -rnE "[\'\\\\"](@aws-cdk-blocks/|aws-cdk-blocks(/|[\'\\\\"]))" . --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.mjs" --include="*.cjs" ${excludeArgs} | grep -Ew "import|from|require"`, { cwd: workspace, encoding: \'utf-8\', maxBuffer: 4 * 1024 * 1024 }, )',
		reason: 'The only interpolation is --exclude-dir flags built from the constant STAGE_EXCLUDE_DIRS set in this script.',
	},
	{
		at: 'scripts/monte-carlo.ts', in: 'gh', site: 'execSync(`gh ${cmd}`, { encoding: "utf-8" })',
		reason: 'Maintainer planning script: every gh command is a literal in this file, interpolating only the ORG constant and numeric ids.',
	},
	{
		at: 'scripts/publish/publish.ts', in: 'packPackage', site: 'execSync(`npm pack --pack-destination ${JSON.stringify(packDir)}`, { cwd: pkg.dirPath, encoding: "utf-8", })',
		reason: 'The only value is a mkdtemp() directory under os.tmpdir() that this script just created, double-quoted.',
	},
];

describe('shell sink detector', () => {
	const find = (src) => findShellSinks('sample.ts', src).map((f) => `${f.line}:${f.kind}`);

	it('flags a command string built from a value', () => {
		const src = "import { execSync } from 'node:child_process';\nexport const f = (scope: string) => execSync(`npm view ${scope}/x`);";
		assert.deepEqual(find(src), ['2:shell-command-string']);
	});

	it('flags exec through an alias, a namespace import and require()', () => {
		assert.deepEqual(find("import { exec as run } from 'child_process';\nrun(cmd);"), ['2:shell-command-string']);
		assert.deepEqual(find("import * as cp from 'node:child_process';\ncp.execSync(cmd);"), ['2:shell-command-string']);
		assert.deepEqual(find("const { execSync } = require('child_process');\nexecSync('ls ' + dir);"), ['2:shell-command-string']);
	});

	it('flags any shell option that is not the literal false', () => {
		assert.deepEqual(find("spawn('npm', ['i'], { shell: true });"), ['1:shell-option']);
		assert.deepEqual(find("execFileSync('npm', args, { shell: process.platform === 'win32' });"), ['1:shell-option']);
		assert.deepEqual(find("const shell = true; run('x', [], { shell });"), ['1:shell-option']);
	});

	it('flags a shell program started through argv with a non-constant command', () => {
		const imp = "import { execFile, spawn, spawnSync } from 'node:child_process';\n";
		assert.deepEqual(find(`${imp}execFile('cmd', ['/c', 'start', '', p], cb);`), ['2:shell-program-argv']);
		assert.deepEqual(find(`${imp}spawn('sh', ['-c', \`ls \${dir}\`]);`), ['2:shell-program-argv']);
		assert.deepEqual(find(`${imp}spawnSync('/bin/bash', ['-c', ...cmds]);`), ['2:shell-program-argv']);
		assert.deepEqual(find(`${imp}spawn('pwsh', args);`), ['2:shell-program-argv']);
		assert.deepEqual(find(`${imp}spawn('sh', ['-c', 'echo ok']); spawn('bash', [script, name]);`), []);
	});

	it('resolves a const options object and flags a spread it cannot see into', () => {
		const imp = "import { spawn } from 'node:child_process';\n";
		assert.deepEqual(find(`${imp}const o = { shell: true };\nspawn(cmd, args, o);`), ['2:shell-option']);
		assert.deepEqual(find(`${imp}spawn(cmd, args, { ...o });`), ['2:shell-option-spread']);
		assert.deepEqual(find(`${imp}const base = { cwd: dir };\nspawn(cmd, args, { ...base, stdio: 'inherit' });`), []);
	});

	it('accepts constant commands, argv arrays and shell: false', () => {
		const src = [
			"import { execSync, execFileSync, spawn } from 'node:child_process';",
			"execSync('git config user.name');",
			"const CMD = 'npm install'; execSync(CMD, { stdio: 'inherit' });",
			"execFileSync('npm', ['view', name, 'version']);",
			"spawn('node', [file], { shell: false });",
		].join('\n');
		assert.deepEqual(find(src), []);
	});

	it('ignores an exec method that is not child_process (RegExp.prototype.exec)', () => {
		assert.deepEqual(find('const m = /a(b)/.exec(input);'), []);
	});
});

describe('repo: no value is interpolated into a shell command', () => {
	it('every site uses argv or a constant command, or is allowlisted with a reason', () => {
		const result = compareWithAllowlist(scan(listSourceFiles(), findShellSinks), ALLOWLIST);
		assert.ok(result.unexpected.length === 0 && result.stale.length === 0, report('shell', result));
	});
});
