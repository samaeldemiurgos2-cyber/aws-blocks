// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Synth-warning check for scaffolded templates, shared by the per-PR template
// driver (templates-e2e.mjs) and the daily canary (scripts/canary/run-canary.ts).
//
// Synthesizes an untouched scaffold in every mode its scripts deploy
// (production, sandbox, preview) and fails on any error annotation and on any
// warning annotation that is not listed in EXPECTED_TEMPLATE_WARNINGS (D-033).
//
// The annotations are read from the cloud assembly, not from `cdk synth
// --strict`: `--strict` is all or nothing, so it cannot allow the warnings a
// template is meant to show.
//
// An acknowledged annotation is not written to the assembly, so templates must
// not acknowledge any: the unit test runs findAcknowledgements over them.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { runSpawn } from './_proc.mjs';

/**
 * @typedef {object} Annotation
 * @property {'warning' | 'info' | 'error'} level
 * @property {string | undefined} id the id given to `addWarningV2`/`addInfoV2`;
 *   undefined for the legacy `addWarning`/`addInfo` and for `addError`
 * @property {string} path construct path, e.g. `/my-app-prod/Hosting`
 * @property {string} message the text without the trailing ` [ack: <id>]` tag
 */

/**
 * @typedef {object} SynthMode
 * @property {string} name
 * @property {string[]} context `key=value` pairs passed as `--context`
 */

/**
 * The warnings an untouched scaffold is meant to show, by template.
 *
 * An entry is a warning about something the template ships and the developer
 * must act on, and each needs a reason a customer would accept. A default's
 * tradeoff is an info annotation in the block, never an entry here.
 *
 * `modes` names the {@link synthModes} in which the warning fires. An entry
 * that does not fire in one of its modes fails the check, so the list only
 * holds warnings that still exist.
 *
 * @type {Record<string, { id: string, modes: string[], reason: string }[]>}
 */
export const EXPECTED_TEMPLATE_WARNINGS = {
	demo: [
		{
			id: '@aws-cdk-blocks/bb-email-client:UnverifiableSender',
			modes: ['production', 'sandbox', 'preview'],
			reason:
				'The template ships a placeholder sender address on the reserved `.invalid` domain, so every send fails on AWS until the developer sets an address they have verified.',
		},
	],
	'auth-oidc': [
		{
			id: '@aws-cdk-blocks/bb-auth:StubIdpDeployed',
			modes: ['sandbox', 'preview'],
			reason:
				'Outside production the template signs users in through `stubIdp()`, which asks for no credentials, so anyone who can reach a deployed sandbox can sign in.',
		},
		{
			// Fires only on the first synth of a stack (the block writes its baseline
			// into the app). Preview reuses the sandbox stack name, so it is not
			// listed there; a rerun over an already synthesized scaffold reports this
			// entry as no longer firing.
			id: '@aws-cdk-blocks/bb-auth:FirstBaselineWithoutPool',
			modes: ['production', 'sandbox'],
			reason:
				'A first baseline with no owned user pool cannot tell a new app from one migrating off a pool-backed block, so the block warns once, on the first synth of each stack.',
		},
	],
};

/** Cloud assembly metadata entry types that are annotations, by level. */
const LEVELS = new Map([
	['aws:cdk:warning', 'warning'],
	['aws:cdk:info', 'info'],
	['aws:cdk:error', 'error'],
]);

/** The tag `addWarningV2(id, …)` and `addInfoV2(id, …)` append to the message. */
const ACK_TAG = / \[ack: ([^\]]+)\]$/;

/** How much of a message a problem line shows. */
const MESSAGE_PREVIEW = 200;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

/**
 * Read every warning, info and error annotation out of a synthesized cloud
 * assembly (a `cdk.out` directory), including its nested assemblies (what a
 * Stage synthesizes to).
 *
 * aws-cdk-lib writes a stack's metadata to a file next to the manifest, named
 * by the stack artifact's `additionalMetadataFile`; the assembly schema also
 * allows it inline (`metadata`). Both are read, as the CDK CLI does. A missing
 * manifest or metadata file throws.
 *
 * @param {string} assemblyDir
 * @returns {Annotation[]}
 */
export function readAnnotations(assemblyDir) {
	const annotations = [];
	for (const artifact of Object.values(readJson(join(assemblyDir, 'manifest.json')).artifacts ?? {})) {
		if (artifact.type === 'cdk:cloud-assembly') {
			annotations.push(...readAnnotations(join(assemblyDir, artifact.properties.directoryName)));
		}
		if (artifact.type !== 'aws:cloudformation:stack') continue;
		const sources = [artifact.metadata ?? {}];
		if (artifact.additionalMetadataFile) sources.push(readJson(join(assemblyDir, artifact.additionalMetadataFile)));
		for (const [path, entries] of sources.flatMap((metadata) => Object.entries(metadata))) {
			for (const entry of entries) {
				const level = LEVELS.get(entry.type);
				if (!level) continue;
				const ack = ACK_TAG.exec(entry.data);
				annotations.push({ level, id: ack?.[1], path, message: ack ? entry.data.slice(0, ack.index) : entry.data });
			}
		}
	}
	return annotations;
}

/**
 * The modes an app is synthesized in, in the order they run: production,
 * sandbox, and preview when the app has a `sandbox:preview` script (the
 * templates with `Hosting`; for a backend-only template preview is the same
 * synth as sandbox).
 *
 * @param {string} appDir
 * @returns {SynthMode[]}
 */
export function synthModes(appDir) {
	const modes = [
		{ name: 'production', context: [] },
		{ name: 'sandbox', context: ['sandboxMode=true'] },
	];
	if (readJson(join(appDir, 'package.json')).scripts?.['sandbox:preview']) {
		modes.push({ name: 'preview', context: ['sandboxMode=true', 'previewMode=true'] });
	}
	return modes;
}

/** `<level> <id> at <construct path>: <start of the message>`, on one line. */
function describeAnnotation(annotation) {
	const text = annotation.message.replace(/\s+/g, ' ').trim();
	const preview = text.length > MESSAGE_PREVIEW ? `${text.slice(0, MESSAGE_PREVIEW)}…` : text;
	return `${annotation.level} ${annotation.id ?? '(no id)'} at ${annotation.path}: ${preview}`;
}

/**
 * What is wrong with the annotations of one synth: every error, every warning
 * whose id is not expected (a warning without an id can never be expected),
 * and every expected id that did not fire. Info annotations are ignored.
 *
 * @param {Annotation[]} annotations
 * @param {Iterable<string>} [expectedIds] ids of the warnings this synth is meant to show
 * @returns {string[]} one line per problem; empty when there is none
 */
export function findProblems(annotations, expectedIds = []) {
	const expected = new Set(expectedIds);
	const fired = new Set();
	const problems = [];
	for (const annotation of annotations) {
		if (annotation.level === 'error') {
			problems.push(describeAnnotation(annotation));
		} else if (annotation.level === 'warning') {
			if (annotation.id !== undefined && expected.has(annotation.id)) fired.add(annotation.id);
			else problems.push(`unexpected ${describeAnnotation(annotation)}`);
		}
	}
	for (const id of expected) {
		if (!fired.has(id)) {
			problems.push(`expected warning ${id} no longer fires: remove it from EXPECTED_TEMPLATE_WARNINGS`);
		}
	}
	return problems;
}

/** Directories of an app that hold no source of its own: dependencies and build output. */
const NOT_APP_SOURCE = new Set(['node_modules', 'dist', 'build', 'cdk.out', 'vendor']);

/** Extensions of the files an app's CDK code can be written in. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** `Annotations.acknowledgeWarning` / `acknowledgeInfo`, or `Validations.acknowledge`. */
const ACKNOWLEDGEMENT = /\.acknowledge(?:Warning|Info)?\s*\(/;

/**
 * Every line of source under `dir` that acknowledges an annotation, as
 * `<file>:<line>: <text>` with the file relative to `dir`. Dependencies, build
 * output and dot-directories are skipped.
 *
 * @param {string} dir a template directory or a scaffolded app
 * @returns {string[]}
 */
export function findAcknowledgements(dir) {
	const found = [];
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				if (!NOT_APP_SOURCE.has(entry.name) && !entry.name.startsWith('.')) walk(path);
			} else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
				readFileSync(path, 'utf-8')
					.split('\n')
					.forEach((line, index) => {
						if (ACKNOWLEDGEMENT.test(line)) found.push(`${relative(dir, path)}:${index + 1}: ${line.trim()}`);
					});
			}
		}
	};
	walk(dir);
	return found.sort();
}

/**
 * Synthesize a scaffolded app in each of its {@link synthModes} and check the
 * annotations against EXPECTED_TEMPLATE_WARNINGS.
 *
 * Each mode synthesizes into `<outDir>/<mode>` with the app's own `cdk.json`
 * command. Synth needs no AWS credentials. In an app with `Hosting` it runs
 * the app's frontend build.
 *
 * @param {object} options
 * @param {string} options.template template name, the key into EXPECTED_TEMPLATE_WARNINGS
 * @param {string} options.appDir the scaffolded app
 * @param {string} options.outDir directory that receives one cloud assembly per mode
 * @param {NodeJS.ProcessEnv} options.env environment for the CDK CLI
 * @returns {string[]} problems, each prefixed with its mode; empty when the check passes
 */
export function checkTemplateSynthWarnings({ template, appDir, outDir, env }) {
	if (!existsSync(join(appDir, 'cdk.json'))) {
		console.log(`  Synth warning check skipped: template ${template} has no cdk.json`);
		return [];
	}
	const expected = EXPECTED_TEMPLATE_WARNINGS[template] ?? [];
	const problems = [];
	for (const mode of synthModes(appDir)) {
		const modeOut = join(outDir, mode.name);
		// `--region` pins CDK_DEFAULT_REGION: hosting's CloudFrontAlarmRegionUnresolved
		// is an info only when it is us-east-1, and a warning otherwise.
		const args = ['--no', 'cdk', 'synth', '--quiet', '--region', 'us-east-1', '--output', modeOut];
		const result = runSpawn('npx', [...args, ...mode.context.flatMap((pair) => ['--context', pair])], {
			cwd: appDir,
			env,
		});
		let found;
		if (result.status !== 0) {
			found = [`cdk synth ${result.error ? `could not start: ${result.error.message}` : `exited ${result.status}`}`];
		} else {
			try {
				const expectedIds = expected.filter((entry) => entry.modes.includes(mode.name)).map((entry) => entry.id);
				found = findProblems(readAnnotations(modeOut), expectedIds);
			} catch (error) {
				found = [error?.message ?? String(error)];
			}
		}
		for (const problem of found) problems.push(`${mode.name}: ${problem}`);
	}
	if (problems.length > 0) {
		// A scaffold installs the newest aws-cdk-lib its range allows, and a new release can add a warning.
		const cdkLib = join(appDir, 'node_modules', 'aws-cdk-lib', 'package.json');
		console.error(`  aws-cdk-lib ${existsSync(cdkLib) ? readJson(cdkLib).version : 'unknown'} is installed in the scaffolded app.`);
	}
	return problems;
}
