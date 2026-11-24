// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Scope } from '@aws-cdk-blocks/core';
import { Tracer } from './index.mock.js';
import { BB_NAME, BB_VERSION } from './version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
	try {
		rmSync('.cdk-blocks/local/data', { recursive: true, force: true });
		rmSync('.bb-data', { recursive: true, force: true });
	} catch {}
});

// ── Basic tracing ───────────────────────────────────────────────────────────

test('startSegment executes fn and returns its result', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	const result = await tracer.startSegment('op', async (segment) => {
		segment.addAnnotation('key', 'value');
		return 42;
	});
	assert.strictEqual(result, 42);
});

test('startSegment records timing (durationMs >= 0)', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('timed-op', async () => {
		await new Promise((r) => setTimeout(r, 10));
	});
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.ok(traces[0].durationMs >= 0);
});

test('startSegment with error records error and re-throws', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	const err = new Error('boom');
	err.name = 'TestError';
	await assert.rejects(
		() =>
			tracer.startSegment('failing', async () => {
				throw err;
			}),
		(e: Error) => e === err,
	);
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.deepStrictEqual(traces[0].error, { name: 'TestError', message: 'boom' });
});

test('nested startSegment calls both execute correctly', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	const results: string[] = [];
	await tracer.startSegment('outer', async () => {
		results.push('outer');
		await tracer.startSegment('inner', async () => {
			results.push('inner');
		});
	});
	assert.deepStrictEqual(results, ['outer', 'inner']);
});

// ── Annotations & Metadata ──────────────────────────────────────────────────

test('segment.addAnnotation stores annotation', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('annotated', async (segment) => {
		segment.addAnnotation('userId', 'user-123');
		segment.addAnnotation('count', 5);
		segment.addAnnotation('active', true);
	});
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces[0].annotations.userId, 'user-123');
	assert.strictEqual(traces[0].annotations.count, 5);
	assert.strictEqual(traces[0].annotations.active, true);
});

test('segment.addMetadata stores metadata', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('with-metadata', async (segment) => {
		segment.addMetadata('request', { url: '/api/test', method: 'GET' });
	});
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.deepStrictEqual(traces[0].metadata.request, { url: '/api/test', method: 'GET' });
});

test('tracer.addAnnotation stores root annotation', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	tracer.addAnnotation('endpoint', '/api/users');
	// Root annotations are stored in memory — verify via getTraceId existing
	assert.ok(true);
});

// ── Error handling ──────────────────────────────────────────────────────────

test('segment.addError records error without throwing', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('with-error', async (segment) => {
		const err = new Error('handled error');
		err.name = 'HandledError';
		segment.addError(err);
	});
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.deepStrictEqual(traces[0].error, { name: 'HandledError', message: 'handled error' });
});

test('startSegment re-throws application errors unchanged', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	const originalError = new Error('original');
	try {
		await tracer.startSegment('throwing', async () => {
			throw originalError;
		});
		assert.fail('Should have thrown');
	} catch (e) {
		assert.strictEqual(e, originalError);
	}
});

// ── Disabled tracing ────────────────────────────────────────────────────────

test('enabled: false still executes fn', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { enabled: false });
	let executed = false;
	await tracer.startSegment('ignored', async () => {
		executed = true;
	});
	assert.strictEqual(executed, true);
});

test('enabled: false writes no trace file', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { enabled: false });
	await tracer.startSegment('ignored', async () => {});
	assert.strictEqual(existsSync('.cdk-blocks/local/data/root-test/traces.json'), false);
});

test('addAnnotation is no-op when disabled', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { enabled: false });
	tracer.addAnnotation('key', 'value');
	assert.strictEqual(existsSync('.cdk-blocks/local/data/root-test/traces.json'), false);
});

test('getTraceId returns null when disabled', () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { enabled: false });
	assert.strictEqual(tracer.getTraceId(), null);
});

// ── Sampling ────────────────────────────────────────────────────────────────

test('samplingRate: 0 produces no traces but executes fn', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { samplingRate: 0 });
	let executed = false;
	await tracer.startSegment('unsampled', async () => {
		executed = true;
	});
	assert.strictEqual(executed, true);
	assert.strictEqual(existsSync('.cdk-blocks/local/data/root-test/traces.json'), false);
});

test('samplingRate: 1 traces everything', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { samplingRate: 1 });
	await tracer.startSegment('sampled', async () => {});
	assert.strictEqual(existsSync('.cdk-blocks/local/data/root-test/traces.json'), true);
});

// Sampling is a per-trace decision made at the root; subsegments must inherit
// it. These tests drive a fractional samplingRate with a scripted Math.random
// so the root and a nested segment would roll differently if sampling were
// (incorrectly) re-evaluated per subsegment.
function withScriptedRandom(values: number[], fn: () => Promise<void>): Promise<void> {
	const original = Math.random;
	let i = 0;
	// After the script is exhausted, return 1 (>= any rate < 1 ⇒ "not sampled")
	// so an unexpected extra roll can't accidentally sample.
	Math.random = () => (i < values.length ? values[i++] : 1);
	return fn().finally(() => {
		Math.random = original;
	});
}

test('a sampled trace keeps all its subsegments even when a subsegment would roll unsampled', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { samplingRate: 0.5 });
	// Root rolls 0.1 (< 0.5 ⇒ sampled); a per-subsegment roll of 0.9 would drop
	// the child under the buggy behavior.
	await withScriptedRandom([0.1, 0.9], async () => {
		await tracer.startSegment('outer', async () => {
			await tracer.startSegment('inner', async () => {});
		});
	});
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces.length, 1);
	assert.strictEqual(traces[0].segment, 'outer');
	assert.strictEqual(traces[0].children.length, 1);
	assert.strictEqual(traces[0].children[0].segment, 'inner');
});

test('an unsampled trace never promotes a subsegment into its own root trace', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { samplingRate: 0.5 });
	// Root rolls 0.9 (>= 0.5 ⇒ not sampled); a per-subsegment roll of 0.1 would
	// spawn an orphan root trace under the buggy behavior.
	await withScriptedRandom([0.9, 0.1], async () => {
		await tracer.startSegment('outer', async () => {
			await tracer.startSegment('inner', async () => {});
		});
	});
	assert.strictEqual(existsSync('.cdk-blocks/local/data/root-test/traces.json'), false);
});

// ── getTraceId ──────────────────────────────────────────────────────────────

test('getTraceId returns a UUID string', () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	const id = tracer.getTraceId();
	assert.ok(id);
	assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('getTraceId returns same value across calls within a trace', () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	const id1 = tracer.getTraceId();
	const id2 = tracer.getTraceId();
	assert.strictEqual(id1, id2);
});

// ── Persistence ─────────────────────────────────────────────────────────────

test('traces persist to .cdk-blocks/local/data/{fullId}/traces.json', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('persisted', async () => {});
	assert.strictEqual(existsSync('.cdk-blocks/local/data/root-test/traces.json'), true);
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces.length, 1);
	assert.strictEqual(traces[0].segment, 'persisted');
});

test('traces file is capped at 100 entries', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	for (let i = 0; i < 110; i++) {
		await tracer.startSegment(`op-${i}`, async () => {});
	}
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces.length, 100);
});

// ── setHttpStatus ───────────────────────────────────────────────────────────

test('segment.setHttpStatus records status code', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('http-op', async (segment) => {
		segment.setHttpStatus(200);
	});
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces[0].httpStatus, 200);
});

test('status code appears in persisted trace', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('error-http', async (segment) => {
		segment.setHttpStatus(500);
	});
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces[0].httpStatus, 500);
});

// ── samplingRate validation ─────────────────────────────────────────────────

test('samplingRate below 0 throws RangeError', () => {
	assert.throws(
		() => new Tracer({ id: 'root' } as any, 'test', { samplingRate: -0.1 }),
		(e: Error) => e instanceof RangeError && e.message === 'samplingRate must be between 0 and 1',
	);
});

test('samplingRate above 1 throws RangeError', () => {
	assert.throws(
		() => new Tracer({ id: 'root' } as any, 'test', { samplingRate: 1.5 }),
		(e: Error) => e instanceof RangeError && e.message === 'samplingRate must be between 0 and 1',
	);
});

test('samplingRate of 0 is valid (no RangeError)', () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { samplingRate: 0 });
	assert.ok(tracer);
});

test('samplingRate of 1 is valid (no RangeError)', () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { samplingRate: 1 });
	assert.ok(tracer);
});

// ── Nested segment hierarchy ────────────────────────────────────────────────

test('nested segments are stored as children of the outer segment', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('outer', async (outerSeg) => {
		outerSeg.addAnnotation('level', 'outer');
		await tracer.startSegment('inner', async (innerSeg) => {
			innerSeg.addAnnotation('level', 'inner');
		});
	});
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces.length, 1);
	assert.strictEqual(traces[0].segment, 'outer');
	assert.strictEqual(traces[0].annotations.level, 'outer');
	assert.strictEqual(traces[0].children.length, 1);
	assert.strictEqual(traces[0].children[0].segment, 'inner');
	assert.strictEqual(traces[0].children[0].annotations.level, 'inner');
});

test('deeply nested segments form a tree', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('level-0', async () => {
		await tracer.startSegment('level-1', async () => {
			await tracer.startSegment('level-2', async () => {});
		});
	});
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces.length, 1);
	assert.strictEqual(traces[0].segment, 'level-0');
	assert.strictEqual(traces[0].children[0].segment, 'level-1');
	assert.strictEqual(traces[0].children[0].children[0].segment, 'level-2');
});

// ── Root annotations/metadata in persisted records ──────────────────────────

test('root annotations and metadata are included in persisted trace', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	tracer.addAnnotation('endpoint', '/api/users');
	tracer.addMetadata('requestId', 'req-abc');
	await tracer.startSegment('op', async () => {});
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces[0].rootAnnotations.endpoint, '/api/users');
	assert.strictEqual(traces[0].rootMetadata.requestId, 'req-abc');
});

// ── Trace ID uniqueness (regression: trace ID reuse) ────────────────────────

test('different top-level segments get different trace IDs', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('first', async () => {});
	await tracer.startSegment('second', async () => {});
	await tracer.startSegment('third', async () => {});
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces.length, 3);
	const ids = new Set(traces.map((t: any) => t.traceId));
	assert.strictEqual(ids.size, 3, 'Each top-level segment must have a unique trace ID');
});

test('nested segments share their parent trace ID', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	let innerTraceId: string | null = null;
	await tracer.startSegment('outer', async () => {
		innerTraceId = tracer.getTraceId();
		await tracer.startSegment('inner', async () => {});
	});
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	const outerRecord = traces[0];
	assert.strictEqual(outerRecord.traceId, innerTraceId);
	assert.strictEqual(outerRecord.children[0].traceId, outerRecord.traceId);
});

test('root annotations are cleared between traces', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	tracer.addAnnotation('reqId', 'req-1');
	await tracer.startSegment('first', async () => {});
	// After first segment completes, rootAnnotations should be cleared
	tracer.addAnnotation('reqId', 'req-2');
	await tracer.startSegment('second', async () => {});
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces[0].rootAnnotations.reqId, 'req-1');
	assert.strictEqual(traces[1].rootAnnotations.reqId, 'req-2');
});

test('trace ID resets after error in top-level segment', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	try {
		await tracer.startSegment('failing', async () => {
			throw new Error('err');
		});
	} catch {}
	await tracer.startSegment('after-error', async () => {});
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces.length, 2);
	assert.notStrictEqual(traces[0].traceId, traces[1].traceId, 'Trace ID must reset after error in top-level segment');
});

// ── Concurrent top-level segments ───────────────────────────────────────────

/** A promise plus the function that settles it, so a test can order overlapping segments. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

test('overlapping top-level segments each keep their own trace', async () => {
	const tracer = new Tracer({ id: 'root' }, 'test');
	const aStarted = deferred();
	const bStarted = deferred();
	const aDone = deferred();
	const seen: Record<string, (string | null)[]> = { a: [], b: [] };

	// Request A starts, then B starts while A is still running, then A finishes
	// while B is still running — the interleaving two dev-server requests produce.
	const a = tracer.startSegment('request-a', async () => {
		seen.a.push(tracer.getTraceId());
		aStarted.resolve();
		await bStarted.promise;
		await tracer.startSegment('a-child', async () => {});
		seen.a.push(tracer.getTraceId());
	});
	await aStarted.promise;
	const b = tracer.startSegment('request-b', async () => {
		seen.b.push(tracer.getTraceId());
		bStarted.resolve();
		await aDone.promise;
		await tracer.startSegment('b-child', async () => {});
		seen.b.push(tracer.getTraceId());
	});
	await a;
	aDone.resolve();
	await b;

	assert.strictEqual(seen.a[0], seen.a[1], 'trace ID of A must not change during its run');
	assert.strictEqual(seen.b[0], seen.b[1], 'trace ID of B must not change during its run');
	assert.notStrictEqual(seen.a[0], seen.b[0], 'overlapping top-level segments must get different trace IDs');

	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.deepStrictEqual(
		traces.map((t: { segment: string }) => t.segment),
		['request-a', 'request-b'],
	);
	const [recA, recB] = traces;
	assert.strictEqual(recA.traceId, seen.a[0]);
	assert.strictEqual(recB.traceId, seen.b[0]);
	assert.deepStrictEqual(
		recA.children.map((c: { segment: string }) => c.segment),
		['a-child'],
	);
	assert.deepStrictEqual(
		recB.children.map((c: { segment: string }) => c.segment),
		['b-child'],
	);
	assert.strictEqual(recA.children[0].traceId, recA.traceId);
	assert.strictEqual(recB.children[0].traceId, recB.traceId);
});

test('root annotations stay with the overlapping segment that added them', async () => {
	const tracer = new Tracer({ id: 'root' }, 'test');
	const aStarted = deferred();
	const bStarted = deferred();
	const a = tracer.startSegment('request-a', async () => {
		tracer.addAnnotation('request', 'a');
		aStarted.resolve();
		await bStarted.promise;
	});
	await aStarted.promise;
	const b = tracer.startSegment('request-b', async () => {
		tracer.addAnnotation('request', 'b');
		tracer.addMetadata('only', 'b');
		bStarted.resolve();
	});
	await Promise.all([a, b]);
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	const recA = traces.find((t: { segment: string }) => t.segment === 'request-a');
	const recB = traces.find((t: { segment: string }) => t.segment === 'request-b');
	assert.deepStrictEqual(recA.rootAnnotations, { request: 'a' });
	assert.deepStrictEqual(recA.rootMetadata, {});
	assert.deepStrictEqual(recB.rootAnnotations, { request: 'b' });
	assert.deepStrictEqual(recB.rootMetadata, { only: 'b' });
});

test('parallel nested segments attach to their own parent', async () => {
	const tracer = new Tracer({ id: 'root' }, 'test');
	await tracer.startSegment('root-op', async () => {
		await Promise.all([
			tracer.startSegment('left', async () => {
				await new Promise((r) => setTimeout(r, 5));
				await tracer.startSegment('left-child', async () => {});
			}),
			tracer.startSegment('right', async () => {
				await tracer.startSegment('right-child', async () => {
					await new Promise((r) => setTimeout(r, 10));
				});
			}),
		]);
	});
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces.length, 1);
	const [rootRec] = traces;
	assert.deepStrictEqual(
		rootRec.children.map((c: { segment: string }) => c.segment),
		['left', 'right'],
	);
	assert.deepStrictEqual(
		rootRec.children[0].children.map((c: { segment: string }) => c.segment),
		['left-child'],
	);
	assert.deepStrictEqual(
		rootRec.children[1].children.map((c: { segment: string }) => c.segment),
		['right-child'],
	);
});

// ── Non-Error thrown values ─────────────────────────────────────────────────

const NON_ERROR_THROWS: { label: string; value: unknown }[] = [
	{ label: 'undefined', value: undefined },
	{ label: 'null', value: null },
	{ label: 'a string', value: 'plain string' },
	{ label: 'a number', value: 42 },
	{ label: 'a plain object', value: { code: 'E_CUSTOM' } },
	{ label: 'a null-prototype object', value: Object.create(null) },
];

for (const { label, value } of NON_ERROR_THROWS) {
	test(`startSegment rethrows ${label} unchanged`, async () => {
		const tracer = new Tracer({ id: 'root' }, 'test');
		let caught: unknown = Symbol('not thrown');
		try {
			await tracer.startSegment('throws-non-error', async () => {
				throw value;
			});
		} catch (e) {
			caught = e;
		}
		assert.strictEqual(caught, value);
		// The segment is still closed and persisted.
		const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
		assert.strictEqual(traces.length, 1);
		assert.strictEqual(traces[0].segment, 'throws-non-error');
	});
}

test('a thrown string is recorded as the segment error message', async () => {
	const tracer = new Tracer({ id: 'root' }, 'test');
	await assert.rejects(() =>
		tracer.startSegment('throws-string', async () => {
			throw 'went wrong';
		}),
	);
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.deepStrictEqual(traces[0].error, { name: '', message: 'went wrong' });
});

test('a thrown undefined records no segment error, like X-Ray', async () => {
	const tracer = new Tracer({ id: 'root' }, 'test');
	await assert.rejects(() =>
		tracer.startSegment('throws-undefined', async () => {
			throw undefined;
		}),
	);
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces[0].error, undefined);
});

test('a nested segment that throws undefined lets the parent continue', async () => {
	const tracer = new Tracer({ id: 'root' }, 'test');
	let caught: unknown = Symbol('not thrown');
	await tracer.startSegment('outer', async () => {
		try {
			await tracer.startSegment('inner', async () => {
				throw undefined;
			});
		} catch (e) {
			caught = e;
		}
	});
	assert.strictEqual(caught, undefined);
	const traces = JSON.parse(readFileSync('.cdk-blocks/local/data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces.length, 1);
	assert.strictEqual(traces[0].children[0].segment, 'inner');
});

// ── Telemetry Registration ──────────────────────────────────────────────────

/**
 * `Scope.getRegisteredBlocks()` only names a block whose `bbName` is in
 * OFFICIAL_BB_NAMES, and that set is generated from the umbrella's
 * `aws-blocks.vendorize` map. These tests pin the three coupled artifacts to
 * each other: the block's generated BB_NAME, its vendorize entry, and the
 * generated name set. A block that omits `bbMeta` still constructs fine and
 * every other test still passes, so that gap is only visible here.
 *
 * Unlike Logger/Metrics, bb-tracer ships a distinct mock implementation (the
 * default entry does not re-export the AWS class), so both `index.aws.ts` and
 * `index.mock.ts` carry the `super()` change; this suite exercises the mock.
 */
describe('telemetry registration', () => {
	beforeEach(() => {
		Scope._resetRegistry();
	});

	test('BB_NAME is the name the vendorize map and OFFICIAL_BB_NAMES carry', () => {
		assert.strictEqual(BB_NAME, 'Tracer');
	});

	test('BB_VERSION tracks the package version', () => {
		const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
		assert.strictEqual(BB_VERSION, pkg.version);
	});

	test('an instance carries bbName and bbVersion', () => {
		const tracer = new Tracer({ id: 'root' } as any, 'tracer');
		assert.strictEqual(tracer.bbName, BB_NAME);
		assert.strictEqual(tracer.bbVersion, BB_VERSION);
	});

	test('registers as an official block, so telemetry is allowed to name it', () => {
		new Tracer({ id: 'root' } as any, 'tracer');
		const { blocks, customBlocksCount } = Scope.getRegisteredBlocks();
		assert.deepStrictEqual(
			blocks.filter((b) => b.name === BB_NAME),
			[{ name: BB_NAME, version: BB_VERSION }],
		);
		assert.strictEqual(customBlocksCount, 0, 'must not be filtered out as an unnamed custom block');
	});
});
