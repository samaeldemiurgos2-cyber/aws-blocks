// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Run: node --test scripts/sync-catalog.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { escapeCell, extractBetweenMarkers, extractBlurb, formatKeywords, injectCatalog } from './sync-catalog.mjs';

const BEGIN_MARKER = '<!-- BEGIN:block-catalog -->';
const END_MARKER = '<!-- END:block-catalog -->';

describe('extractBlurb', () => {
  const cases = [
    {
      name: 'returns the first sentence after the h1',
      content: '# Block\n\nProvides the first capability. Additional details follow.',
      expected: 'Provides the first capability.',
    },
    {
      name: 'returns the whole line when it has no sentence-ending period',
      content: '# Block\nProvides a capability without punctuation',
      expected: 'Provides a capability without punctuation',
    },
    {
      name: 'skips blank lines after the h1',
      content: '# Block\n\n  \nProvides a capability.',
      expected: 'Provides a capability.',
    },
    {
      name: 'returns empty when the document has no h1',
      content: '## Block\nProvides a capability.',
      expected: '',
    },
    {
      name: 'stops at a heading before descriptive text',
      content: '# Block\n\n## Usage\nProvides a capability.',
      expected: '',
    },
    {
      name: 'stops at an HTML comment before descriptive text',
      content: '# Block\n\n<!-- generated -->\nProvides a capability.',
      expected: '',
    },
  ];

  for (const { name, content, expected } of cases) {
    it(name, () => {
      assert.equal(extractBlurb(content), expected);
    });
  }
});

describe('catalog markers', () => {
  const readme = `Before\n${BEGIN_MARKER}\nOld table\n${END_MARKER}\nAfter`;

  it('extracts the content between valid markers', () => {
    assert.equal(extractBetweenMarkers(readme), '\nOld table\n');
  });

  it('injects a catalog without changing content outside the markers', () => {
    assert.equal(
      injectCatalog(readme, 'New table'),
      `Before\n${BEGIN_MARKER}\nNew table\n${END_MARKER}\nAfter`,
    );
  });

  const invalidCases = [
    { name: 'missing begin marker', readme: `Before\n${END_MARKER}\nAfter` },
    { name: 'missing end marker', readme: `Before\n${BEGIN_MARKER}\nAfter` },
    { name: 'end marker before begin marker', readme: `${END_MARKER}\n${BEGIN_MARKER}` },
  ];

  for (const { name, readme: invalidReadme } of invalidCases) {
    it(`returns null for ${name}`, () => {
      assert.equal(extractBetweenMarkers(invalidReadme), null);
    });

    it(`throws on write for ${name}`, () => {
      assert.throws(() => injectCatalog(invalidReadme, 'New table'), /catalog markers .* not found/);
    });
  }
});

describe('escapeCell', () => {
  it('escapes pipes so a value stays in one table cell', () => {
    assert.equal(escapeCell('a | b'), 'a \\| b');
  });

  it('escapes backslashes before pipes', () => {
    assert.equal(escapeCell('a\\|b \\ c'), 'a\\\\\\|b \\\\ c');
  });

  it('returns an empty string for a missing value', () => {
    assert.equal(escapeCell(undefined), '');
  });
});

describe('formatKeywords', () => {
  it('lists the keywords in package.json order', () => {
    assert.equal(formatKeywords(['queue', 'sqs', 'lambda']), 'queue, sqs, lambda');
  });

  it('leaves out the discovery tag every package carries', () => {
    assert.equal(formatKeywords(['cdk-blocks', 'queue', 'cdk-blocks-queue']), 'queue, cdk-blocks-queue');
  });

  it('returns an empty string when only the discovery tag is declared', () => {
    assert.equal(formatKeywords(['cdk-blocks']), '');
  });

  it('drops blank entries, so the discovery tag plus blanks is an empty cell', () => {
    assert.equal(formatKeywords(['cdk-blocks', '', ' ']), '');
    assert.equal(formatKeywords([' queue ', '', 'sqs']), 'queue, sqs');
  });

  it('returns an empty string when keywords is absent or not an array', () => {
    assert.equal(formatKeywords(undefined), '');
    assert.equal(formatKeywords('queue, sqs'), '');
  });
});

// The script roots itself at `<its own dir>/../packages`, so a copy placed in a
// throwaway workspace's scripts/ sees that workspace as the repo. Each case runs
// the real script against real files.
describe('--check', () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));

  function workspace(t, keywords) {
    const dir = mkdtempSync(join(tmpdir(), 'sync-catalog-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    mkdirSync(join(dir, 'scripts'));
    for (const file of ['sync-catalog.mjs', 'block-packages.mjs', 'discovery-keyword.mjs']) {
      copyFileSync(join(scriptsDir, file), join(dir, 'scripts', file));
    }
    mkdirSync(join(dir, 'packages', 'blocks'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'blocks', 'README.md'), `# Blocks\n\n${BEGIN_MARKER}\n${END_MARKER}\n`);
    mkdirSync(join(dir, 'packages', 'bb-queue'));
    writeFileSync(join(dir, 'packages', 'bb-queue', 'README.md'), '# Queue\n\nA message queue.\n');
    writeFileSync(join(dir, 'packages', 'bb-queue', 'package.json'), JSON.stringify({ name: 'bb-queue', keywords }));
    return dir;
  }

  function run(dir, mode) {
    return spawnSync(process.execPath, [join(dir, 'scripts', 'sync-catalog.mjs'), mode], { encoding: 'utf-8' });
  }

  it('passes for a synced catalog whose block declares its own keywords', (t) => {
    const dir = workspace(t, ['cdk-blocks', 'queue', 'sqs']);
    assert.equal(run(dir, '--write').status, 0);

    assert.equal(run(dir, '--check').status, 0);
  });

  it('fails for a synced catalog whose block declares only the discovery tag', (t) => {
    const dir = workspace(t, ['cdk-blocks']);
    assert.equal(run(dir, '--write').status, 0);

    const check = run(dir, '--check');
    assert.equal(check.status, 1);
    assert.match(check.stderr, /No keywords for the Building Block catalog: bb-queue\./);
  });

  it('fails when the committed catalog no longer matches package.json keywords', (t) => {
    const dir = workspace(t, ['cdk-blocks', 'queue']);
    assert.equal(run(dir, '--write').status, 0);
    writeFileSync(
      join(dir, 'packages', 'bb-queue', 'package.json'),
      JSON.stringify({ name: 'bb-queue', keywords: ['cdk-blocks', 'queue', 'sqs'] }),
    );

    const check = run(dir, '--check');
    assert.equal(check.status, 1);
    assert.match(check.stderr, /catalog in packages\/blocks\/README\.md is out of date/);
  });
});
