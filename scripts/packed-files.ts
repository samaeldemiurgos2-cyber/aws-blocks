// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';

/** The package-relative paths `npm pack` would publish. */
export function packedFiles(pkgDir: string): string[] {
	const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
		cwd: pkgDir,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const [entry] = JSON.parse(out) as { files: { path: string }[] }[];
	return entry.files.map((f) => f.path);
}
