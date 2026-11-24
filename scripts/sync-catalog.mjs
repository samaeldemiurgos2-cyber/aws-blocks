#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keeps the committed Building Block *catalog table* in packages/blocks/README.md
 * in sync with the per-block packages: the blurb comes from each README, the
 * keywords from each package.json. This script ONLY manages the table between
 * the `<!-- BEGIN:block-catalog -->` / `<!-- END:block-catalog -->` markers — it
 * leaves the rest of the README (the static decision-tree prose, etc.) untouched
 * and does NOT generate the shipped `docs/` artifact. That artifact (per-block
 * docs/<pkg>/ folders + docs/README.md copy) is produced by
 * scripts/gen-block-docs.mjs, run as the packages/blocks `prebuild` and `prepack` hooks.
 *
 * Two modes:
 *
 *   --write  (default; `npm run sync-docs`, run MANUALLY when adding/removing a block)
 *     Render the catalog table from the discovered blocks and inject it between
 *     the markers in packages/blocks/README.md. Nothing else in the README changes.
 *
 *   --check  (CI / PR gate; `npm run sync-docs:check`)
 *     Render the catalog table in memory and compare it to what is committed
 *     between the markers. Exit 1 with an actionable message if they differ, the
 *     markers are missing, or a block declares no keyword besides the discovery
 *     tag (its Keywords cell would be blank); exit 0 otherwise. Writes nothing.
 *
 * Inclusion rule: every package under packages/ that has a README.md and is not in
 * EXCLUDED.
 *
 * Keywords: package.json `keywords` is the only source, the same array npm search
 * indexes and scripts/keywords-guard.ts checks. A README carries no keyword list.
 *
 * The block set (inclusion rule + EXCLUDED) is shared with gen-block-docs.mjs via
 * block-packages.mjs so the two generators can't drift.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBlockPackages, packagesDir } from './block-packages.mjs';
import { DISCOVERY_KEYWORD } from './discovery-keyword.mjs';

const readmePath = join(packagesDir, 'blocks', 'README.md');

const BEGIN_MARKER = '<!-- BEGIN:block-catalog -->';
const END_MARKER = '<!-- END:block-catalog -->';

const SYNC_HINT = 'Run `npm run sync-docs` and commit the result.';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

// ─── Modes ───────────────────────────────────────────────────────────────────

function main() {
  const mode = process.argv.includes('--check') ? 'check' : 'write';
  const packages = getBlockPackages();
  const catalog = buildCatalog(packages);
  const table = renderCatalogTable(catalog);

  if (mode === 'check') {
    runCheck(catalog, table);
  } else {
    runWrite(catalog, table);
  }
}

function runCheck(catalog, table) {
  const blank = catalog.filter((entry) => !entry.keywords).map((entry) => entry.pkg);
  if (blank.length > 0) {
    process.stderr.write(
      `❌ No keywords for the Building Block catalog: ${blank.join(', ')}. Add keywords that describe what the block does to "keywords" in its package.json, next to "${DISCOVERY_KEYWORD}". ${SYNC_HINT}\n`,
    );
    process.exit(1);
  }

  const readme = readFileSync(readmePath, 'utf-8');
  const current = extractBetweenMarkers(readme);

  if (current === null) {
    process.stderr.write(
      `❌ Building Block catalog markers (${BEGIN_MARKER} / ${END_MARKER}) not found in packages/blocks/README.md. ${SYNC_HINT}\n`,
    );
    process.exit(1);
  }

  if (current.trim() !== table.trim()) {
    process.stderr.write(
      `❌ Building Block catalog in packages/blocks/README.md is out of date. ${SYNC_HINT}\n`,
    );
    process.exit(1);
  }

  console.log('✅ Building Block catalog in packages/blocks/README.md is up to date.');
  process.exit(0);
}

function runWrite(catalog, table) {
  const readme = readFileSync(readmePath, 'utf-8');
  const updated = injectCatalog(readme, table);
  if (updated !== readme) writeFileSync(readmePath, updated);
  console.log(`Synced ${catalog.length} blocks → packages/blocks/README.md catalog`);
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

function buildCatalog(pkgs) {
  const entries = pkgs.map((pkg) => {
    const readme = readFileSync(join(packagesDir, pkg, 'README.md'), 'utf-8');
    const manifest = JSON.parse(readFileSync(join(packagesDir, pkg, 'package.json'), 'utf-8'));
    return { pkg, blurb: extractBlurb(readme), keywords: formatKeywords(manifest.keywords) };
  });
  entries.sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0));
  return entries;
}

function renderCatalogTable(entries) {
  const rows = entries.map(
    (e) => `| ${e.pkg} | ${escapeCell(e.blurb.replaceAll('AWS CDK Blocks', 'CDK Blocks')) || '—'} | ${escapeCell(e.keywords) || '—'} |`,
  );
  return ['| Block | What it does | Keywords |', '|-------|--------------|----------|', ...rows].join('\n');
}

export function escapeCell(value) {
  // Backslash first, so the `\|` the pipe escape adds is not escaped again.
  return (value || '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

// ─── Marker helpers ──────────────────────────────────────────────────────────

export function injectCatalog(readme, catalogTable) {
  const begin = readme.indexOf(BEGIN_MARKER);
  const end = readme.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `Building Block catalog markers (${BEGIN_MARKER} / ${END_MARKER}) not found in packages/blocks/README.md. ` +
        'Add them where the catalog table should live, then re-run.',
    );
  }
  const before = readme.slice(0, begin + BEGIN_MARKER.length);
  const after = readme.slice(end);
  return `${before}\n${catalogTable}\n${after}`;
}

export function extractBetweenMarkers(readme) {
  const begin = readme.indexOf(BEGIN_MARKER);
  const end = readme.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) return null;
  return readme.slice(begin + BEGIN_MARKER.length, end);
}

// ─── README parsing ──────────────────────────────────────────────────────────

export function extractBlurb(content) {
  const lines = content.split('\n');
  const h1 = lines.findIndex((l) => l.startsWith('# '));
  if (h1 === -1) return '';
  for (let i = h1 + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('<!--')) break;
    const firstSentence = line.match(/^.*?\.(?:\s|$)/);
    return (firstSentence ? firstSentence[0] : line).trim();
  }
  return '';
}

// ─── package.json parsing ────────────────────────────────────────────────────

/**
 * The Keywords cell for a package.json `keywords` value: every keyword but the
 * discovery tag. Blank entries are dropped, so a list of only the tag and blanks
 * gives an empty cell.
 */
export function formatKeywords(keywords) {
  if (!Array.isArray(keywords)) return '';
  return keywords
    .filter((keyword) => typeof keyword === 'string')
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword && keyword !== DISCOVERY_KEYWORD)
    .join(', ');
}
