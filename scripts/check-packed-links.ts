// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { packedFiles } from './packed-files.ts';

const REPO_BLOB_URL = 'https://github.com/aws/cdk-blocks/blob/main';

interface Inventory {
	name: string;
	files: ReadonlySet<string>;
}

type Inventories = ReadonlyMap<string, Inventory>;

type DeadLink = { reason: 'not-packed'; owner: string } | { reason: 'outside' };

function relativeLinks(markdown: string): string[] {
	const prose = markdown.replace(/^\s*(`{3,}|~{3,}).*\n[\s\S]*?^\s*\1.*$/gm, '').replace(/(`+)[^\n]*?\1/g, '');
	const links = new Set<string>();
	for (const [, href] of prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
		if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) continue;
		links.add(href);
	}
	return [...links];
}

function deadLink(file: string, href: string, inventories: Inventories): DeadLink | null {
	const path = href.split('#')[0];
	if (path.startsWith('/')) return { reason: 'outside' };
	const [fromDir] = file.split('/');
	const [dir, ...rest] = posix.normalize(posix.join(posix.dirname(file), path)).split('/');
	const owner = inventories.get(dir);
	const from = inventories.get(fromDir);
	if (!owner || !from) return { reason: 'outside' };
	if (dir !== fromDir) {
		// npm installs `@scope/a` and `@scope/b` as siblings under `node_modules/@scope/`, so
		// `../b/x.md` resolves there only when both share the scope and `b` is its directory here.
		const [scope, unscoped] = owner.name.split('/');
		if (unscoped !== dir || !from.name.startsWith(`${scope}/`)) return { reason: 'outside' };
	}
	const target = rest.join('/').replace(/\/$/, '');
	if (target === '' || owner.files.has(target)) return null;
	for (const packed of owner.files) if (packed.startsWith(`${target}/`)) return null;
	return { reason: 'not-packed', owner: dir };
}

function main(argv: string[]): number {
	const { values } = parseArgs({ args: argv, options: { root: { type: 'string' } } });
	const packagesDir = join(resolve(values.root ?? join(import.meta.dirname, '..')), 'packages');

	const inventories = new Map<string, Inventory>();
	for (const dir of readdirSync(packagesDir).sort()) {
		const manifestPath = join(packagesDir, dir, 'package.json');
		if (!existsSync(manifestPath)) continue;
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { name: string; private?: boolean };
		if (manifest.private) continue;
		inventories.set(dir, { name: manifest.name, files: new Set(packedFiles(join(packagesDir, dir))) });
	}

	const offenders: string[] = [];
	let checked = 0;

	for (const [dir, { name, files }] of inventories) {
		for (const path of [...files].sort()) {
			if (!path.endsWith('.md') || posix.basename(path) === 'CHANGELOG.md') continue;
			const file = `${dir}/${path}`;
			for (const href of relativeLinks(readFileSync(join(packagesDir, file), 'utf-8'))) {
				checked++;
				const dead = deadLink(file, href, inventories);
				if (!dead) continue;
				console.log(`  ✗ ${name}: ${path} → ${href}`);
				const repoPath = posix.normalize(posix.join('packages', posix.dirname(file), href.split('#')[0]));
				const url = `${REPO_BLOB_URL}/${repoPath}`;
				offenders.push(
					dead.reason === 'not-packed'
						? `packages/${file} links to ${href}, which the packed tarball does not contain. ` +
								`Add the target to "files" in packages/${dead.owner}/package.json, or link to ${url}`
						: `packages/${file} links to ${href}, which is outside every package npm installs next to this one. ` +
								`Link to ${url}`,
				);
			}
		}
	}

	if (checked === 0) {
		console.error('ERROR: found no relative link in a packed Markdown file of any package under packages/.');
		return 1;
	}

	if (offenders.length > 0) {
		console.error('ERRORS:');
		for (const err of offenders) console.error(`  • ${err}`);
		return 1;
	}

	console.log(`All ${checked} relative link(s) in packed Markdown resolve to packed files.`);
	return 0;
}

process.exit(main(process.argv.slice(2)));
