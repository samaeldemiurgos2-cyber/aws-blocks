// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/ci/template-synth-warnings.mjs. The assemblies are
// fixtures written to a temp dir in the shapes aws-cdk-lib writes; nothing
// here runs `cdk`. The acknowledgement scan also runs over the templates in
// this repo.
//
// Run: node --test scripts/ci/template-synth-warnings.test.mjs

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	EXPECTED_TEMPLATE_WARNINGS,
	findAcknowledgements,
	findProblems,
	readAnnotations,
	synthModes,
} from './template-synth-warnings.mjs';

const TEMPLATES_DIR = fileURLToPath(new URL('../../packages/create-blocks-app/templates/', import.meta.url));

const tmp = mkdtempSync(join(tmpdir(), 'template-synth-warnings-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

let dirs = 0;
/** Writes `files` (relative path → JSON value) into a fresh directory and returns it. */
function writeDir(files) {
	const dir = join(tmp, `dir-${dirs++}`);
	mkdirSync(dir, { recursive: true });
	for (const [relative, value] of Object.entries(files)) {
		const file = join(dir, relative);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(value));
	}
	return dir;
}

const manifest = (artifacts) => ({ version: '55.0.0', artifacts });

/** A stack artifact as aws-cdk-lib writes it, trimmed to the fields that matter here. */
const stackArtifact = (extra = {}) => ({
	type: 'aws:cloudformation:stack',
	environment: 'aws://unknown-account/unknown-region',
	properties: { templateFile: 'stack.template.json' },
	...extra,
});

/** A metadata entry for an annotation of `level` (`warning`, `info` or `error`). */
const entry = (level, data) => ({ type: `aws:cdk:${level}`, data, trace: ['Annotations.addMessage (…)'] });

/** Metadata entries that are not annotations and must be ignored. */
const OTHER_ENTRIES = [
	{ type: 'aws:cdk:creationStack', data: ['file:///app/cdk-blocks/index.cdk.ts:17:1'] },
	{ type: 'aws:cdk:logicalId', data: 'Topic1234ABCD' },
];

const annotation = (level, id, path, message) => ({ level, id, path, message });

describe('readAnnotations', () => {
	it('reads every level, with and without an id, from the metadata sidecar', () => {
		const dir = writeDir({
			'manifest.json': manifest({
				'Main.assets': { type: 'cdk:asset-manifest', properties: { file: 'Main.assets.json' } },
				Main: stackArtifact({ additionalMetadataFile: 'Main.metadata.json', displayName: 'Main' }),
				Tree: { type: 'cdk:tree', properties: { file: 'tree.json' } },
			}),
			'Main.metadata.json': {
				'/Main': [...OTHER_ENTRIES],
				'/Main/A': [
					...OTHER_ENTRIES,
					entry('warning', 'v2 warning message [ack: my:pkg:WarnV2]'),
					entry('warning', 'legacy warning message'),
					entry('info', 'v2 info message [ack: my:pkg:InfoV2]'),
					entry('info', 'legacy info message'),
				],
				'/Main/B': [entry('error', 'error message')],
			},
		});
		assert.deepEqual(readAnnotations(dir), [
			annotation('warning', 'my:pkg:WarnV2', '/Main/A', 'v2 warning message'),
			annotation('warning', undefined, '/Main/A', 'legacy warning message'),
			annotation('info', 'my:pkg:InfoV2', '/Main/A', 'v2 info message'),
			annotation('info', undefined, '/Main/A', 'legacy info message'),
			annotation('error', undefined, '/Main/B', 'error message'),
		]);
	});

	it('also reads metadata stored inline in the manifest', () => {
		const dir = writeDir({
			'manifest.json': manifest({
				Main: stackArtifact({
					additionalMetadataFile: 'Main.metadata.json',
					metadata: { '/Main/A': [...OTHER_ENTRIES, entry('warning', 'from the manifest [ack: my:pkg:Inline]')] },
				}),
			}),
			'Main.metadata.json': { '/Main/A': [entry('warning', 'from the sidecar [ack: my:pkg:Sidecar]')] },
		});
		assert.deepEqual(readAnnotations(dir), [
			annotation('warning', 'my:pkg:Inline', '/Main/A', 'from the manifest'),
			annotation('warning', 'my:pkg:Sidecar', '/Main/A', 'from the sidecar'),
		]);
	});

	it('reads a nested assembly, also when the outer one has no stack of its own', () => {
		const dir = writeDir({
			'manifest.json': manifest({
				'assembly-Stg': { type: 'cdk:cloud-assembly', properties: { directoryName: 'assembly-Stg', displayName: 'Stg' } },
				Tree: { type: 'cdk:tree', properties: { file: 'tree.json' } },
			}),
			'assembly-Stg/manifest.json': manifest({
				StgInner2A814D4F: stackArtifact({ additionalMetadataFile: 'StgInner2A814D4F.metadata.json', displayName: 'Stg/Inner' }),
			}),
			'assembly-Stg/StgInner2A814D4F.metadata.json': {
				'/Stg/Inner': [entry('warning', 'stage stack warning [ack: my:pkg:InStage]')],
			},
		});
		assert.deepEqual(readAnnotations(dir), [annotation('warning', 'my:pkg:InStage', '/Stg/Inner', 'stage stack warning')]);
	});

	it('reads every stack of the assembly', () => {
		const dir = writeDir({
			'manifest.json': manifest({
				Main: stackArtifact({ additionalMetadataFile: 'Main.metadata.json', displayName: 'Main' }),
				// A stack without annotations or other metadata names no sidecar.
				Quiet: stackArtifact({ displayName: 'Quiet' }),
				Support: stackArtifact({
					environment: 'aws://unknown-account/us-east-1',
					additionalMetadataFile: 'Support.metadata.json',
					displayName: 'Support',
				}),
			}),
			'Main.metadata.json': { '/Main': [entry('info', 'main stack info [ack: my:pkg:MainInfo]')] },
			'Support.metadata.json': { '/Support': [entry('warning', 'support stack warning [ack: my:pkg:SupportStack]')] },
		});
		assert.deepEqual(readAnnotations(dir), [
			annotation('info', 'my:pkg:MainInfo', '/Main', 'main stack info'),
			annotation('warning', 'my:pkg:SupportStack', '/Support', 'support stack warning'),
		]);
	});

	it('throws when the manifest, a named metadata file or a nested assembly is missing', () => {
		assert.throws(() => readAnnotations(join(tmp, 'never-synthesized')), /manifest\.json/);
		const noSidecar = writeDir({
			'manifest.json': manifest({ Main: stackArtifact({ additionalMetadataFile: 'Main.metadata.json' }) }),
		});
		assert.throws(() => readAnnotations(noSidecar), /Main\.metadata\.json/);
		const noNested = writeDir({
			'manifest.json': manifest({
				'assembly-Stg': { type: 'cdk:cloud-assembly', properties: { directoryName: 'assembly-Stg' } },
			}),
		});
		assert.throws(() => readAnnotations(noNested), /assembly-Stg/);
	});
});

describe('findProblems', () => {
	const warning = (id, message = 'something to act on') => annotation('warning', id, '/app-prod/Thing', message);

	it('passes a synth without annotations, and ignores infos', () => {
		assert.deepEqual(findProblems([]), []);
		assert.deepEqual(findProblems([annotation('info', 'my:pkg:Info', '/app-prod', 'a default tradeoff')]), []);
		assert.deepEqual(findProblems([annotation('info', undefined, '/app-prod', 'legacy info')], []), []);
	});

	it('reports a warning that is not expected, with its id, construct path and message', () => {
		const problems = findProblems([warning('my:pkg:New')], ['my:pkg:Other', 'my:pkg:Fired']);
		assert.equal(problems.length, 3);
		assert.equal(problems[0], 'unexpected warning my:pkg:New at /app-prod/Thing: something to act on');
	});

	it('never expects a warning without an id', () => {
		const problems = findProblems([warning(undefined, 'legacy warning')], ['undefined', 'legacy warning']);
		assert.equal(problems[0], 'unexpected warning (no id) at /app-prod/Thing: legacy warning');
	});

	it('reports every error, also one whose id is listed as expected', () => {
		const error = annotation('error', undefined, '/app-prod/Thing', 'cannot deploy this');
		assert.deepEqual(findProblems([error]), ['error (no id) at /app-prod/Thing: cannot deploy this']);
		const tagged = annotation('error', 'my:pkg:Fired', '/app-prod/Thing', 'cannot deploy this');
		assert.deepEqual(findProblems([tagged, warning('my:pkg:Fired')], ['my:pkg:Fired']), [
			'error my:pkg:Fired at /app-prod/Thing: cannot deploy this',
		]);
	});

	it('passes an expected warning that fired, also on several constructs', () => {
		assert.deepEqual(findProblems([warning('my:pkg:Fired')], ['my:pkg:Fired']), []);
		const twice = [warning('my:pkg:Fired'), annotation('warning', 'my:pkg:Fired', '/app-prod/Other', 'again')];
		assert.deepEqual(findProblems(twice, new Set(['my:pkg:Fired'])), []);
	});

	it('reports an expected warning that did not fire', () => {
		const stale = 'expected warning my:pkg:Gone no longer fires: remove it from EXPECTED_TEMPLATE_WARNINGS';
		assert.deepEqual(findProblems([], ['my:pkg:Gone']), [stale]);
		assert.deepEqual(findProblems([warning('my:pkg:Fired')], ['my:pkg:Fired', 'my:pkg:Gone']), [stale]);
		// An info with the id is not the warning.
		assert.deepEqual(findProblems([annotation('info', 'my:pkg:Gone', '/app-prod', 'now an info')], ['my:pkg:Gone']), [stale]);
	});

	it('shows the start of a long message on one line', () => {
		const [problem] = findProblems([warning('my:pkg:Long', `first line\n  second line ${'x'.repeat(300)}`)]);
		assert.ok(problem.startsWith('unexpected warning my:pkg:Long at /app-prod/Thing: first line second line xxx'), problem);
		assert.ok(problem.endsWith('x…'), problem);
		assert.equal(problem.length, 'unexpected warning my:pkg:Long at /app-prod/Thing: '.length + 200 + '…'.length);
	});
});

describe('synthModes', () => {
	const appWithScripts = (scripts) => writeDir({ 'package.json': { name: 'my-app', scripts } });

	it('synthesizes production, then sandbox, then preview for an app with a sandbox:preview script', () => {
		const app = appWithScripts({ sandbox: 'cdk-blocks sandbox', 'sandbox:preview': 'cdk-blocks sandbox preview' });
		assert.deepEqual(synthModes(app), [
			{ name: 'production', context: [] },
			{ name: 'sandbox', context: ['sandboxMode=true'] },
			{ name: 'preview', context: ['sandboxMode=true', 'previewMode=true'] },
		]);
	});

	it('leaves preview out for an app without a sandbox:preview script', () => {
		const expected = [
			{ name: 'production', context: [] },
			{ name: 'sandbox', context: ['sandboxMode=true'] },
		];
		assert.deepEqual(synthModes(appWithScripts({ sandbox: 'cdk-blocks sandbox' })), expected);
		assert.deepEqual(synthModes(writeDir({ 'package.json': { name: 'my-app' } })), expected);
	});
});

describe('EXPECTED_TEMPLATE_WARNINGS', () => {
	const entries = Object.entries(EXPECTED_TEMPLATE_WARNINGS);

	it('names templates that exist', () => {
		assert.ok(entries.length > 0);
		for (const [template] of entries) {
			const dir = join(TEMPLATES_DIR, template);
			assert.ok(existsSync(dir) && statSync(dir).isDirectory(), `no template "${template}" under ${TEMPLATES_DIR}`);
		}
	});

	it("names modes the template's app is synthesized in", () => {
		for (const [template, expected] of entries) {
			const modes = synthModes(join(TEMPLATES_DIR, template)).map((mode) => mode.name);
			for (const { id, modes: listed } of expected) {
				assert.ok(listed.length > 0, `${template}: ${id} lists no mode`);
				for (const mode of listed) {
					assert.ok(modes.includes(mode), `${template}: ${id} lists mode "${mode}", which is not one of ${modes.join(', ')}`);
				}
				assert.equal(new Set(listed).size, listed.length, `${template}: ${id} lists a mode twice`);
			}
		}
	});

	it('gives every warning an id and a reason, once per template', () => {
		for (const [template, expected] of entries) {
			assert.ok(expected.length > 0, `${template}: an empty list; remove the key`);
			for (const { id, reason } of expected) {
				assert.equal(typeof id, 'string', template);
				assert.ok(id.trim().length > 0, `${template}: an entry without an id`);
				assert.equal(typeof reason, 'string', `${template}: ${id} has no reason`);
				assert.ok(reason.trim().length > 0, `${template}: ${id} has no reason`);
			}
			const ids = expected.map((e) => e.id);
			assert.equal(new Set(ids).size, ids.length, `${template}: an id is listed twice`);
		}
	});
});

describe('findAcknowledgements', () => {
	/** Writes `files` (relative path → source text) into a fresh directory and returns it. */
	function writeSources(files) {
		const dir = writeDir({});
		for (const [relative, text] of Object.entries(files)) {
			const file = join(dir, relative);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, text);
		}
		return dir;
	}

	it('reports each acknowledgement call in the app source, with its file and line', () => {
		const dir = writeSources({
			'cdk-blocks/index.cdk.ts': [
				"import { Annotations } from 'aws-cdk-lib';",
				"Annotations.of(blocksStack).acknowledgeWarning('blocks:example:warning');",
				'',
				"  Annotations.of(hosting).acknowledgeInfo( 'blocks:example:info', 'known' );",
				"Validations.of(blocksStack).acknowledge({ id: 'blocks:example:warning', reason: 'known' });",
			].join('\n'),
			'cdk-blocks/index.ts': "export const api = 'no annotations here';\n",
		});
		assert.deepEqual(findAcknowledgements(dir), [
			`${join('cdk-blocks', 'index.cdk.ts')}:2: Annotations.of(blocksStack).acknowledgeWarning('blocks:example:warning');`,
			`${join('cdk-blocks', 'index.cdk.ts')}:4: Annotations.of(hosting).acknowledgeInfo( 'blocks:example:info', 'known' );`,
			`${join('cdk-blocks', 'index.cdk.ts')}:5: Validations.of(blocksStack).acknowledge({ id: 'blocks:example:warning', reason: 'known' });`,
		]);
	});

	it('reads only the app source: no dependencies, build output, dot-directories or docs', () => {
		const call = "Annotations.of(stack).acknowledgeWarning('blocks:example:warning');\n";
		const dir = writeSources({
			'node_modules/aws-cdk-lib/core/lib/annotations.js': call,
			'dist/index.cdk.js': call,
			'cdk.out/asset.1/index.js': call,
			'vendor/bb-kv-store/src/index.cdk.ts': call,
			'.cdk-blocks/generated.ts': call,
			'README.md': `Call \`${call.trim()}\` to hide it.\n`,
			'src/acknowledge.ts': 'export const acknowledgeWarningBanner = () => acknowledged;\n',
		});
		assert.deepEqual(findAcknowledgements(dir), []);
	});

	it('finds no acknowledgement in the templates: a scaffold must not hide an annotation', () => {
		assert.deepEqual(findAcknowledgements(TEMPLATES_DIR), []);
	});
});
