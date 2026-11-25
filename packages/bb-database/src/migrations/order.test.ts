// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { compareMigrationNames, sortMigrationNames } from './order.js';
import { buildMigrationPlan } from './plan.js';

describe('migration file order', () => {
	test('numbers without zero padding run by their value', () => {
		assert.deepStrictEqual(sortMigrationNames(['10_add_b.sql', '1_create.sql', '2_add_a.sql']), [
			'1_create.sql',
			'2_add_a.sql',
			'10_add_b.sql',
		]);
		assert.deepStrictEqual(sortMigrationNames(['V10__b.sql', 'V2__a.sql', 'V1__init.sql']), [
			'V1__init.sql',
			'V2__a.sql',
			'V10__b.sql',
		]);
	});

	test('zero-padded and timestamped names keep the order a plain sort gives them', () => {
		const names = [
			'002_orders_customer_index.sql',
			'001_init.sql',
			'010_audit.sql',
			'20260102_b.sql',
			'20260101_a.sql',
			'001_init_b.sql',
		];
		assert.deepStrictEqual(sortMigrationNames(names), [...names].sort());
	});

	test('text before a number decides the order before the number does', () => {
		// `a_` sorts before `b_`, whatever the numbers after them are. Comparing only the numbers would also make the
		// order a cycle: `1` < `_` < `0_` < `1`. Here it is `0_` < `1` < `_`.
		assert.ok(compareMigrationNames('a_2.sql', 'b_1.sql') < 0);
		assert.ok(compareMigrationNames('b_1.sql', 'a_2.sql') > 0);
		assert.deepStrictEqual(sortMigrationNames(['_', '1', '0_']), ['0_', '1', '_']);
		assert.ok(compareMigrationNames('_', '0_') > 0);
	});

	test('a name whose runs are a prefix of another name sorts first', () => {
		// `1` and `01` are equal by value, so the name with fewer runs sorts first. A plain code-unit comparison
		// here would put `01a` before `1`, while `1` < `1_` < `01a`: a cycle, so the order would depend on the engine.
		assert.ok(compareMigrationNames('1', '01_') < 0);
		assert.ok(compareMigrationNames('01_', '1') > 0);
		assert.ok(compareMigrationNames('1', '1_') < 0);
		assert.ok(compareMigrationNames('1_', '01a') < 0);
		assert.ok(compareMigrationNames('1', '01a') < 0);
	});

	test('a number in the middle of a name compares by value too', () => {
		assert.deepStrictEqual(sortMigrationNames(['1_step10.sql', '1_step9.sql']), ['1_step9.sql', '1_step10.sql']);
	});

	test('numbers longer than a safe integer compare exactly', () => {
		const a = '90071992547409931_a.sql';
		const b = '90071992547409932_a.sql';
		assert.ok(compareMigrationNames(a, b) < 0);
		assert.ok(compareMigrationNames('9_a.sql', a) < 0);
	});

	test('the order is total: names equal by number fall back to code-unit order', () => {
		assert.ok(compareMigrationNames('01_a.sql', '1_a.sql') < 0);
		assert.ok(compareMigrationNames('1_a.sql', '01_a.sql') > 0);
		assert.strictEqual(compareMigrationNames('1_a.sql', '1_a.sql'), 0);
	});

	test('the plan runs the files in that order', () => {
		const plan = buildMigrationPlan(
			{ '10_add_b.sql': 'SELECT 3;', '1_create.sql': 'SELECT 1;', '2_add_a.sql': 'SELECT 2;' },
			'aurora',
		);
		assert.deepStrictEqual(
			plan.files.map((f) => f.file),
			['1_create.sql', '2_add_a.sql', '10_add_b.sql'],
		);
	});
});
