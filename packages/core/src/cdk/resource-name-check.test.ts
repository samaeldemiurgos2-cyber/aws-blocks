// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The CDK `Scope`: an id that cannot be part of a resource's physical name
 * fails `cdk synth`. Scope and block ids are joined into `fullId`, which names
 * the block's table, queue, schedule, user pool or secret. Each
 * service accepts its own characters, so `new Scope('@acme/shop')` with a
 * `KVStore` under it synthesizes a table named `…-@acme/shop-…`, which
 * DynamoDB rejects a minute into the deploy, and the stack rolls back.
 */
import assert from 'node:assert';
import { describe, test } from 'node:test';
import { App, Aws, CfnCondition, CfnResource, Fn, Stack } from 'aws-cdk-lib';
import { CfnDataSource, CfnKnowledgeBase } from 'aws-cdk-lib/aws-bedrock';
import { UserPool } from 'aws-cdk-lib/aws-cognito';
import { AttributeType, CfnTable, Table, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { CfnSchedule, CfnScheduleGroup } from 'aws-cdk-lib/aws-scheduler';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { ScopeParent } from '../common/index.js';
import { Scope } from './index.js';
import { BLOCKS_BACKEND_ROOT } from './root-registry.js';

/** A stack branded as a backend root, with the `id` a BlocksStack sets, which roots each `fullId`. */
function root(id = 'App'): Stack {
	const stack = Object.assign(new Stack(new App(), id), { id });
	(stack as unknown as Record<symbol, unknown>)[BLOCKS_BACKEND_ROOT] = true;
	return stack;
}

/** The resources Building Blocks name from `fullId`, each built the way its block builds it. */
const RESOURCES = {
	table: (block: Scope, name: string) =>
		new Table(block, 'table', { tableName: name, partitionKey: { name: 'pk', type: AttributeType.STRING } }),
	globalTable: (block: Scope, name: string) =>
		new TableV2(block, 'table', { tableName: name, partitionKey: { name: 'pk', type: AttributeType.STRING } }),
	queue: (block: Scope, name: string) => new Queue(block, 'queue', { queueName: name }),
	fifoQueue: (block: Scope, name: string) => new Queue(block, 'queue', { queueName: `${name}.fifo`, fifo: true }),
	schedule: (block: Scope, name: string) =>
		new CfnSchedule(block, 'Schedule', {
			name,
			scheduleExpression: 'rate(1 day)',
			flexibleTimeWindow: { mode: 'OFF' },
			target: {
				arn: 'arn:aws:lambda:us-east-1:111122223333:function:f',
				roleArn: 'arn:aws:iam::111122223333:role/r',
			},
		}),
	userPool: (block: Scope, name: string) => new UserPool(block, 'pool', { userPoolName: name }),
	secret: (block: Scope, name: string) => new Secret(block, 'secret', { secretName: name }),
	lambda: (block: Scope, name: string) =>
		new LambdaFunction(block, 'fn', {
			functionName: name,
			runtime: Runtime.NODEJS_22_X,
			handler: 'index.handler',
			code: Code.fromInline('exports.handler = async () => {};'),
		}),
	knowledgeBase: (block: Scope, name: string) =>
		new CfnKnowledgeBase(block, 'KB', {
			name,
			roleArn: 'arn:aws:iam::111122223333:role/r',
			knowledgeBaseConfiguration: { type: 'VECTOR' },
		}),
	dataSource: (block: Scope, name: string) =>
		new CfnDataSource(block, 'DataSource', {
			name,
			knowledgeBaseId: 'KB12345678',
			dataSourceConfiguration: { type: 'S3' },
		}),
} satisfies Record<string, (block: Scope, name: string) => unknown>;

type ResourceKind = keyof typeof RESOURCES;

/** A Building Block that names one resource from its `fullId`, as `KVStore` names its table. */
class NamedBlock extends Scope {
	constructor(parent: ScopeParent, id: string, kind: ResourceKind) {
		super(id, { parent, bbName: 'NamedBlock' });
		RESOURCES[kind](this, this.fullId);
	}
}

/** What `cdk synth` reports for the app that owns `stack`: the error message, or `undefined` when it succeeds. */
function synthError(stack: Stack): string | undefined {
	try {
		App.of(stack)?.synth();
		return undefined;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

/** The synth result of one block of `kind` with id `blockId` under a scope with id `scopeId`. */
function synthWith(scopeId: string, kind: ResourceKind, blockId = 'items'): string | undefined {
	const stack = root();
	new NamedBlock(new Scope(scopeId, { parent: stack as never }), blockId, kind);
	return synthError(stack);
}

describe('CDK Scope: an id that a resource name cannot contain fails synth', () => {
	test('a scoped package name as the scope id fails synth for a table named from it', () => {
		const error = synthWith('@acme/shop', 'table', 'carts');
		assert.ok(error, 'synth must fail: DynamoDB rejects the table name at deploy');
		assert.ok(error.includes("'@acme/shop'"), `names the id: ${error}`);
		assert.ok(error.includes("'@'") && error.includes("'/'"), `names the offending characters: ${error}`);
		assert.ok(error.includes('App-@acme/shop-carts'), `names the resource name: ${error}`);
		assert.match(error, /DynamoDB table/, 'names the kind of resource');
		assert.match(error, /letters, digits, '_', '\.' and '-'/, 'names the allowed set');
	});

	test('ids that deploy today still synthesize', () => {
		for (const id of ['shop', 'Shop2', 'my-shop', 'my_shop', 'my.shop', 'a']) {
			assert.strictEqual(synthWith(id, 'table'), undefined, `scope id '${id}' with a table`);
		}
		assert.strictEqual(synthWith('my-shop', 'table', 'user_prefs.v2'), undefined, 'block id with _ and .');
	});

	test('the id is not rejected on its own: a scope with no resource named from it synthesizes', () => {
		const stack = root();
		new Scope('nested', { parent: new Scope('@acme/shop', { parent: stack as never }) });
		assert.strictEqual(synthError(stack), undefined);
	});

	test('a character is rejected only for the resource types that do not accept it', () => {
		// [kind, id the service accepts, id the service rejects]
		const cases: Array<[ResourceKind, string, string]> = [
			['table', 'my_shop.v2', 'acme/shop'],
			['globalTable', 'my_shop.v2', '@acme'],
			['queue', 'my_shop', 'my.shop'],
			['fifoQueue', 'my_shop', 'my.shop'],
			['schedule', 'my_shop.v2', 'acme/shop'],
			['userPool', '@acme shop+a=b,c.d', 'acme/shop'],
			['secret', '@acme/shop_a+b=c.d', 'acme shop'],
			['knowledgeBase', 'my_shop', 'my.shop'],
			['dataSource', 'my_shop', '@acme'],
		];
		for (const [kind, accepted, rejected] of cases) {
			assert.strictEqual(synthWith(accepted, kind), undefined, `${kind} under scope '${accepted}'`);
			const error = synthWith(rejected, kind) ?? '';
			assert.ok(error.includes(`'${rejected}'`), `${kind} under scope '${rejected}': ${error}`);
		}
	});

	test('a block id has the same rule as a scope id', () => {
		const error = synthWith('shop', 'table', 'a/b') ?? '';
		assert.ok(error.includes("'a/b'"), `names the block id: ${error}`);
		assert.ok(error.includes("'/'"), 'names the offending character');
		assert.ok(!error.includes("'shop'"), `does not blame the scope above it: ${error}`);
	});

	test('one error per id, listing every resource name it breaks', () => {
		const stack = root();
		const scope = new Scope('@acme/shop', { parent: stack as never });
		new NamedBlock(scope, 'carts', 'table');
		new NamedBlock(scope, 'orders', 'table');
		new NamedBlock(scope, 'jobs', 'queue');
		new NamedBlock(scope, 'key', 'secret');
		const error = synthError(stack);
		assert.ok(error, 'synth must fail');
		assert.strictEqual(error.split("'@acme/shop'").length - 1, 1, `the id is reported once: ${error}`);
		for (const name of ['App-@acme/shop-carts', 'App-@acme/shop-orders', 'App-@acme/shop-jobs']) {
			assert.ok(error.includes(name), `lists ${name}: ${error}`);
		}
		assert.ok(!error.includes('App-@acme/shop-key'), 'the secret name is valid and is not listed');
	});

	test('a name that is not a literal string is left to the service', () => {
		const stack = root();
		const scope = new Scope('@acme/shop', { parent: stack as never });
		// Generated by CloudFormation: no name in the template.
		new Table(new Scope('generated', { parent: scope }), 'table', {
			partitionKey: { name: 'pk', type: AttributeType.STRING },
		});
		// Resolved at deploy: the template holds an intrinsic function, not the name.
		new Queue(new Scope('deploy-time', { parent: scope }), 'queue', { queueName: `${Aws.STACK_NAME}-a/b` });
		assert.strictEqual(synthError(stack), undefined);
	});

	test('an invalid name that no id explains is reported for the resource', () => {
		const stack = root();
		// The scope id holds a '/' too, but the name was passed explicitly and is not built from it.
		const block = new Scope('carts', { parent: new Scope('acme/shop', { parent: stack as never }) });
		new Table(block, 'table', {
			tableName: 'legacy/carts',
			partitionKey: { name: 'pk', type: AttributeType.STRING },
		});
		const error = synthError(stack) ?? '';
		assert.ok(error.includes('legacy/carts'), `names the resource name: ${error}`);
		assert.ok(error.includes("'/'"), 'names the offending character');
		assert.ok(error.includes(block.node.path), 'names the block that owns the resource');
		assert.ok(!error.includes("'acme/shop'"), `does not blame an id the name is not built from: ${error}`);
	});

	test('resources outside any scope are not checked', () => {
		const stack = root();
		new Scope('shop', { parent: stack as never });
		new Table(stack, 'AppOwned', { tableName: 'a/b', partitionKey: { name: 'pk', type: AttributeType.STRING } });
		assert.strictEqual(synthError(stack), undefined);
	});

	test('each backend root reports its own scopes', () => {
		const app = new App();
		const [first, second] = ['First', 'Second'].map((id) => {
			const stack = Object.assign(new Stack(app, id), { id });
			(stack as unknown as Record<symbol, unknown>)[BLOCKS_BACKEND_ROOT] = true;
			return stack;
		});
		new NamedBlock(new Scope('@acme/one', { parent: first as never }), 'carts', 'table');
		new NamedBlock(new Scope('@acme/two', { parent: second as never }), 'carts', 'table');
		const error = synthError(first) ?? '';
		assert.ok(error.includes("'@acme/one'") && error.includes("'@acme/two'"), `both roots report: ${error}`);
		assert.strictEqual(error.split("'@acme/one'").length - 1, 1, 'each id once');
	});

	test('the name is read from the rendered resource, so a raw override counts', () => {
		/** The synth result of a table under `scopeId`, with its `TableName` overridden to `override`. */
		const synthOverridden = (scopeId: string, override: string) => {
			const stack = root();
			const block = new NamedBlock(new Scope(scopeId, { parent: stack as never }), 'carts', 'table');
			const table = block.node.findAll().find((c) => c instanceof CfnResource);
			assert.ok(table instanceof CfnResource, 'the block has a table');
			table.addPropertyOverride('TableName', override);
			return synthError(stack);
		};
		assert.strictEqual(synthOverridden('@acme/shop', 'acme-shop-carts'), undefined, 'a valid override on a bad id');
		const error = synthOverridden('shop', 'shop/carts');
		assert.ok(error, 'synth must fail: a bad override on a good id');
		assert.ok(error.includes("'shop/carts'") && error.includes("'/'"), `names the overridden name: ${error}`);
	});
});

describe('CDK Scope: two resources with one physical name fail synth', () => {
	/** The synth result of a block of `kind` with id 'x' under `kv > 'a-b'` and another under `kv > 'a' > 'b'`. */
	function synthColliding(kind: ResourceKind): string | undefined {
		const stack = root();
		const kv = new Scope('kv', { parent: stack as never });
		new NamedBlock(new Scope('a-b', { parent: kv }), 'x', kind);
		new NamedBlock(new Scope('b', { parent: new Scope('a', { parent: kv }) }), 'x', kind);
		return synthError(stack);
	}

	test("'a-b' > 'x' and 'a' > 'b' > 'x' fail synth for the table both name 'App-kv-a-b-x'", () => {
		const error = synthColliding('table');
		assert.ok(error, 'synth must fail: CloudFormation rejects the second table with the same name');
		assert.ok(error.includes("DynamoDB table name 'App-kv-a-b-x'"), `names the table: ${error}`);
		assert.ok(error.includes('App/kv/a-b/x/table') && error.includes('App/kv/a/b/x/table'), `both: ${error}`);
		assert.ok(error.includes("'-'"), `explains the join: ${error}`);
	});

	for (const kind of ['globalTable', 'queue', 'fifoQueue', 'schedule', 'secret', 'lambda'] as const) {
		test(`a ${kind} named twice fails synth`, () => {
			const error = synthColliding(kind);
			assert.ok(error, `synth must fail for two ${kind}s with one name`);
			assert.match(error, /App-kv-a-b-x/);
		});
	}

	test('an S3 bucket, a Systems Manager parameter and a log group named twice fail synth', () => {
		const builders = {
			bucket: (block: Scope, name: string) => new Bucket(block, 'bucket', { bucketName: name }),
			parameter: (block: Scope, name: string) =>
				new StringParameter(block, 'param', { parameterName: `/${name}`, stringValue: 'v' }),
			logGroup: (block: Scope, name: string) => new LogGroup(block, 'logs', { logGroupName: name }),
		};
		for (const [kind, build] of Object.entries(builders)) {
			const stack = root();
			build(new Scope('x', { parent: new Scope('a-b', { parent: stack as never }) }), 'app-a-b-x');
			build(new Scope('b-x', { parent: new Scope('a', { parent: stack as never }) }), 'app-a-b-x');
			assert.ok(synthError(stack)?.includes('app-a-b-x'), `${kind}: synth must fail`);
		}
	});

	test('a table and a queue with one name do not collide: each service has its own names', () => {
		const stack = root();
		new NamedBlock(new Scope('a-b', { parent: stack as never }), 'x', 'table');
		new NamedBlock(new Scope('b', { parent: new Scope('a', { parent: stack as never }) }), 'x', 'queue');
		assert.strictEqual(synthError(stack), undefined);
	});

	test('two schedules with one name in different schedule groups do not collide', () => {
		const stack = root();
		const first = new NamedBlock(new Scope('a-b', { parent: stack as never }), 'x', 'schedule');
		const second = new NamedBlock(
			new Scope('b', { parent: new Scope('a', { parent: stack as never }) }),
			'x',
			'schedule',
		);
		for (const [block, group] of [
			[first, 'one'],
			[second, 'two'],
		] as const) {
			const schedule = block.node.findAll().find((c) => c instanceof CfnSchedule);
			assert.ok(schedule instanceof CfnSchedule);
			schedule.groupName = group;
		}
		assert.strictEqual(synthError(stack), undefined);
	});

	test('two Cognito user pools with one name synth: Cognito does not require unique pool names', () => {
		assert.strictEqual(synthColliding('userPool'), undefined);
	});

	test('colliding scopes that name no resource still synth, with the fullIdCollision warning only', () => {
		const stack = root();
		new Scope('x', { parent: new Scope('a-b', { parent: stack as never }) });
		new Scope('x', { parent: new Scope('b', { parent: new Scope('a', { parent: stack as never }) }) });
		assert.strictEqual(synthError(stack), undefined);
	});

	test('one resource per name synths', () => {
		const stack = root();
		new NamedBlock(new Scope('a-b', { parent: stack as never }), 'x', 'table');
		new NamedBlock(new Scope('a', { parent: stack as never }), 'x', 'table');
		assert.strictEqual(synthError(stack), undefined);
	});

	test('two tables with one name behind complementary Conditions synth: only one of them deploys', () => {
		const stack = root();
		const isProd = new CfnCondition(stack, 'IsProd', { expression: Fn.conditionEquals(Aws.ACCOUNT_ID, '1') });
		const notProd = new CfnCondition(stack, 'NotProd', { expression: Fn.conditionNot(isProd) });
		const prod = new NamedBlock(new Scope('a-b', { parent: stack as never }), 'x', 'table');
		const dev = new NamedBlock(
			new Scope('b', { parent: new Scope('a', { parent: stack as never }) }),
			'x',
			'table',
		);
		for (const [block, condition] of [
			[prod, isProd],
			[dev, notProd],
		] as const) {
			const table = block.node.findAll().find((c) => c instanceof CfnTable);
			assert.ok(table instanceof CfnTable);
			table.cfnOptions.condition = condition;
		}
		assert.strictEqual(synthError(stack), undefined);
	});

	test('a secret and a parameter with one name synth: types that share the Name property keep separate names', () => {
		const stack = root();
		new Secret(new Scope('s', { parent: stack as never }), 'secret', { secretName: 'shared-name' });
		new StringParameter(new Scope('p', { parent: stack as never }), 'param', {
			parameterName: 'shared-name',
			stringValue: 'v',
		});
		assert.strictEqual(synthError(stack), undefined);
	});

	test('two tables with one name in stacks in different Regions synth: table names are per Region', () => {
		const stack = root();
		for (const region of ['us-east-1', 'us-west-2']) {
			const child = new Stack(stack, `Stack-${region}`, { env: { account: '111122223333', region } });
			new Table(new Scope('kv', { parent: child as never }), 'table', {
				tableName: 'shared-table',
				partitionKey: { name: 'pk', type: AttributeType.STRING },
			});
		}
		assert.strictEqual(synthError(stack), undefined);
	});

	test('two buckets with one name in stacks in different Regions fail synth: bucket names are global', () => {
		const stack = root();
		for (const region of ['us-east-1', 'us-west-2']) {
			const child = new Stack(stack, `Stack-${region}`, { env: { account: '111122223333', region } });
			new Bucket(new Scope('files', { parent: child as never }), 'bucket', { bucketName: 'shared-bucket-x' });
		}
		const error = synthError(stack);
		assert.ok(error?.includes("S3 bucket name 'shared-bucket-x'"), `synth must fail: ${error}`);
	});

	test('two schedules with one name in one group passed by Ref fail synth', () => {
		const stack = root();
		const group = new CfnScheduleGroup(stack, 'Group', { name: 'jobs' });
		const first = new NamedBlock(new Scope('a-b', { parent: stack as never }), 'x', 'schedule');
		const second = new NamedBlock(
			new Scope('b', { parent: new Scope('a', { parent: stack as never }) }),
			'x',
			'schedule',
		);
		for (const block of [first, second]) {
			const schedule = block.node.findAll().find((c) => c instanceof CfnSchedule);
			assert.ok(schedule instanceof CfnSchedule);
			schedule.groupName = group.ref;
		}
		assert.match(String(synthError(stack)), /EventBridge Scheduler schedule name 'App-a-b-x'/);
	});

	test('a name given twice, not from joined ids, gets a hint to rename the resource instead of the scopes', () => {
		const stack = root();
		new Queue(new Scope('one', { parent: stack as never }), 'queue', { queueName: 'jobs' });
		new Queue(new Scope('two', { parent: stack as never }), 'queue', { queueName: 'jobs' });
		const error = synthError(stack);
		assert.ok(error, 'synth must fail: two queues named jobs');
		assert.ok(error.includes("SQS queue name 'jobs'"), `names the queue: ${error}`);
		assert.ok(error.includes('Give one of them another name'), `hint: ${error}`);
		assert.ok(!error.includes('joined ids differ'), `does not blame the join: ${error}`);
	});
});
