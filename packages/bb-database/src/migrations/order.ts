// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Splits a name into runs of digits and runs of anything else: `10_add_b.sql` → ['10', '_add_b.sql'].
const RUNS = /\d+|\D+/g;
const isDigits = (run: string) => run.charCodeAt(0) >= 48 && run.charCodeAt(0) <= 57;

/**
 * Compares two migration file names in the order the files run: runs of digits by their number, everything else
 * by code unit, so `2_add.sql` runs before `10_add.sql`. Zero-padded names of the same width run in the order a
 * plain `.sort()` gives them. Names that compare equal by number (`1_a.sql`, `01_a.sql`) fall back to a plain
 * code-unit comparison, so the order is total and the same everywhere a migration runs.
 */
export function compareMigrationNames(a: string, b: string): number {
	const left = a.match(RUNS) ?? [];
	const right = b.match(RUNS) ?? [];
	for (let i = 0; i < Math.min(left.length, right.length); i++) {
		const x = left[i];
		const y = right[i];
		if (isDigits(x) && isDigits(y)) {
			// Compared as text without leading zeros, so a number of any length compares exactly.
			const xs = x.replace(/^0+(?=\d)/, '');
			const ys = y.replace(/^0+(?=\d)/, '');
			if (xs.length !== ys.length) return xs.length - ys.length;
			if (xs !== ys) return xs < ys ? -1 : 1;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	if (left.length !== right.length) return left.length - right.length;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** `names` in the order the migration files run. Does not change `names`. */
export function sortMigrationNames(names: Iterable<string>): string[] {
	return [...names].sort(compareMigrationNames);
}
