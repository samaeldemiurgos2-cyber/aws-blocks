// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies the generic `Compute` block owns the concrete, branded backing
 * compute for the stated `type` and exposes it via `resolve()` (the
 * `ComputeProvider` contract) — so the framework's delivery logic resolves and
 * recognizes it.
 *
 * Runs under `--conditions=cdk` so the compute packages resolve their CDK
 * entries (real constructs) rather than the mock stubs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { BlocksStack, BlocksPresets } from '@aws-cdk-blocks/core/cdk';
import { assertEveryRoleBoundedAndReported, GUARD_BOUNDARY } from '@aws-cdk-blocks/core/cdk/internal';
import { LambdaCompute } from '@aws-cdk-blocks/bb-lambda-compute/cdk';
import { ContainerCompute } from '@aws-cdk-blocks/bb-container-compute/cdk';
import { Compute } from './index.cdk.js';

/** A minimal stub compute so BlocksStack.create wires a default without pulling the real one. */
function stubFactory(root: unknown): unknown {
	return new LambdaCompute(root as never, 'DefaultCompute');
}

async function makeStack(): Promise<cdk.Stack> {
	const app = new cdk.App();
	const stack = await BlocksStack.create(app, 'ComputeSelStack', {
		backendHandlerPath: `${process.cwd()}/dist/index.cdk.js`,
		backendCDKPath: `${process.cwd()}/dist/index.cdk.js`,
		defaults: BlocksPresets.production,
		defaultComputeFactory: stubFactory as never,
	} as never);
	return stack as unknown as cdk.Stack;
}

describe('Compute — explicit type selection', () => {
	test("type: 'serverless' owns a LambdaCompute backing", async () => {
		const stack = await makeStack();
		const c = new Compute(stack as never, 'api', { type: 'serverless', memory: 512 });
		// resolve() returns the branded backing the framework wires against.
		assert.ok(LambdaCompute.isLambdaCompute(c.resolve()), 'backing should be a LambdaCompute');
		assert.ok(!ContainerCompute.isContainerCompute(c.resolve()), 'backing should not be a ContainerCompute');
		assert.strictEqual(c.resolve().type, 'serverless');
	});

	test("type: 'container' owns a ContainerCompute backing", async () => {
		const stack = await makeStack();
		const c = new Compute(stack as never, 'worker', { type: 'container', size: { vcpu: 1, memory: 2048 } });
		assert.ok(ContainerCompute.isContainerCompute(c.resolve()), 'backing should be a ContainerCompute');
		assert.ok(!LambdaCompute.isLambdaCompute(c.resolve()), 'backing should not be a LambdaCompute');
		assert.strictEqual(c.resolve().type, 'container');
	});

	test('container backing carries its vcpu for per-CPU concurrency math', async () => {
		const stack = await makeStack();
		const c = new Compute(stack as never, 'worker2', { type: 'container', size: { vcpu: 2, memory: 4096 } });
		assert.strictEqual(c.resolve().vcpu, 2);
	});
});

// ── defaults.permissionsBoundary guard ───────────────────────────────────────
// Every AWS::IAM::Role in every synthesized template (custom-resource provider
// roles and any other stack or helper stack's roles included) must carry the
// configured boundary and be listed in the synth-time IAM report.

describe('Compute under defaults.permissionsBoundary', () => {
	test('every role a serverless and a container Compute create carries the boundary and is in blocks-iam.json', async () => {
		const outdir = mkdtempSync(join(tmpdir(), 'compute-boundary-'));
		try {
			const app = new cdk.App({ outdir });
			const stack = (await BlocksStack.create(app, 'ComputeBoundary', {
				backendHandlerPath: `${process.cwd()}/dist/index.cdk.js`,
				backendCDKPath: `${process.cwd()}/dist/index.cdk.js`,
				defaults: { ...BlocksPresets.production, permissionsBoundary: GUARD_BOUNDARY },
				defaultComputeFactory: stubFactory as never,
			} as never)) as unknown as cdk.Stack;
			new Compute(stack as never, 'api', { type: 'serverless', memory: 512 });
			const worker = new Compute(stack as never, 'worker', {
				type: 'container',
				size: { vcpu: 0.5, memory: 1024 },
			});
			const backing = worker.resolve();
			assert.ok(ContainerCompute.isContainerCompute(backing));
			backing.finalize();
			app.synth();

			const checked = assertEveryRoleBoundedAndReported(outdir, `${stack.artifactId}.blocks-iam.json`);
			assert.ok(
				checked.some((r) => r.includes('worker')),
				`the container backing's roles were checked: ${checked}`,
			);
		} finally {
			rmSync(outdir, { recursive: true, force: true });
		}
	});
});
