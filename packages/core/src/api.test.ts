// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { ApiNamespace, API_NAMESPACE_COMPUTE, API_NAMESPACE_MARKER } from './api.js';
import { Scope } from './common/index.js';
import { resolveApiMethod } from './rpc-dispatch.js';

const scope = new Scope('test');

test('ApiNamespace stores name via marker symbol', () => {
  const api1 = new ApiNamespace(scope, 'myapi', (ctx) => ({
    test: () => 'hello'
  }));
  
  assert.strictEqual((api1 as any)[API_NAMESPACE_MARKER], 'myapi');
});

test('Different ApiNamespace names should not collide', () => {
  const api1 = new ApiNamespace(scope, 'api1', (ctx) => ({ test: () => 'a' }));
  const api2 = new ApiNamespace(scope, 'api2', (ctx) => ({ test: () => 'b' }));
  
  assert.strictEqual((api1 as any)[API_NAMESPACE_MARKER], 'api1');
  assert.strictEqual((api2 as any)[API_NAMESPACE_MARKER], 'api2');
});

// A handler may return a class instance: its prototype methods are the API. This test
// is mostly a compile-time check (the build fails if the constructor's constraint
// rejects a class again); the runtime half confirms the dispatcher calls those methods.
test('ApiNamespace accepts a handler that returns a class instance', async () => {
  class Calculator {
    private readonly offset = 0;
    add(a: number, b: number) {
      return a + b + this.offset;
    }
    async negate(a: number) {
      return -a;
    }
  }
  const api = new ApiNamespace(scope, 'calc', () => new Calculator());
  // The instance type maps each method to a Promise of its (awaited) result.
  const typed: { add: (a: number, b: number) => Promise<number>; negate: (a: number) => Promise<number> } = api;
  assert.strictEqual((typed as any)[API_NAMESPACE_MARKER], 'calc');

  const methods = (api as unknown as () => Calculator)();
  assert.strictEqual(await resolveApiMethod(methods, 'add')?.(2, 3), 5);
  assert.strictEqual(await resolveApiMethod(methods, 'negate')?.(4), -4);
});

// ApiNamespace exposes a resolver for its compute, so the shared gateway can
// resolve it at synth — after the backend module is imported — rather than at
// construction.
test('ApiNamespace resolves its compute from its scope when asked', () => {
  const compute = { id: 'orders-compute' };
  const handler = new ApiNamespace({ id: 'app', compute } as never, 'myapi', () => ({ ping: () => 'ok' }));
  assert.strictEqual((handler as any)[API_NAMESPACE_COMPUTE](), compute);
});

test('ApiNamespace resolves no compute without a scope that has one', () => {
  const scopeless = new ApiNamespace(undefined as never, 'scopeless', () => ({ ping: () => 'ok' }));
  assert.strictEqual((scopeless as any)[API_NAMESPACE_COMPUTE](), undefined);
  const mockScope = new ApiNamespace(new Scope('mock'), 'mockapi', () => ({ ping: () => 'ok' }));
  assert.strictEqual((mockScope as any)[API_NAMESPACE_COMPUTE](), undefined);
});

test('ApiNamespace does not resolve the compute at construction', () => {
  // Reading `scope.compute` here would freeze routing at construction time and
  // throw before create() has built the default compute.
  let reads = 0;
  const scopeLike = {
    id: 'app',
    get compute() {
      reads += 1;
      return { id: 'late-compute' };
    },
  };
  const handler = new ApiNamespace(scopeLike as never, 'late', () => ({ ping: () => 'ok' }));
  assert.strictEqual(reads, 0, 'not read at construction');
  (handler as any)[API_NAMESPACE_COMPUTE]();
  assert.strictEqual(reads, 1, 'read when resolved');
});

test("ApiNamespace's own compute option wins over its scope's compute", () => {
  const scopeCompute = { id: 'scope-compute' };
  const ownCompute = { id: 'own-compute' };
  const provider = { resolve: () => ownCompute };
  const handler = new ApiNamespace({ id: 'app', compute: scopeCompute } as never, 'own', () => ({ ping: () => 'ok' }), {
    compute: provider as never,
  });
  assert.strictEqual((handler as any)[API_NAMESPACE_COMPUTE](), ownCompute);
});

test('ApiNamespace resolves its compute option lazily, like the scope fallback', () => {
  let resolved = 0;
  const provider = { resolve: () => { resolved += 1; return { id: 'c' }; } };
  const handler = new ApiNamespace({ id: 'app' } as never, 'lazy', () => ({ ping: () => 'ok' }), { compute: provider as never });
  assert.strictEqual(resolved, 0, 'not resolved at construction');
  (handler as any)[API_NAMESPACE_COMPUTE]();
  assert.strictEqual(resolved, 1, 'resolved when the gateway asks');
});

test('ApiNamespace is still tagged and returned unchanged in the mock/runtime Scope', () => {
  const handler = new ApiNamespace(new Scope('no-compute'), 'plainapi', () => ({ x: () => 1 }));
  assert.strictEqual((handler as any)[API_NAMESPACE_MARKER], 'plainapi');
  // Symbol keys stay invisible to export scanning and serialization.
  assert.deepStrictEqual(Object.keys(handler), []);
});
