// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * HostingConstruct — CloudFront alarm region wiring (issue #481).
 *
 * AWS/CloudFront metrics only publish in us-east-1 and a CloudWatch
 * alarm can only evaluate a metric in its own region. These tests cover
 * the two-topic fix: off-region, the CloudFront 5xx alarm is placed in a
 * hosting-owned us-east-1 support stack with its own SNS topic; in
 * us-east-1 the behavior is unchanged (single stack, alarm local). In an
 * environment-agnostic stack the alarm is created locally and the synth
 * output says so, at a level decided by the region the CDK CLI targets
 * (`CDK_DEFAULT_REGION`).
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Annotations as CdkAnnotations, App, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { HostingConstruct } from './hosting_construct.js';
import type { DeployManifest } from '../manifest/types.js';

let tmpDir: string;

const createStaticDir = (): string => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-cfregion-'));
  fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
  return tmpDir;
};

const spaManifest = (staticDir: string): DeployManifest => ({
  version: 1,
  compute: {},
  staticAssets: { directory: staticDir },
  routes: [{ pattern: '/*', target: 'static' }],
  buildId: 'cfregion-test-1',
});

const CF_ALARM = Match.objectLike({ Namespace: 'AWS/CloudFront' });

// The trailing `[ack: <id>]` tag addInfoV2 / addWarningV2 append; `$` pins the match to the tag.
const REGION_UNRESOLVED_ACK_TAG = Match.stringLikeRegexp(
  '\\[ack: @aws-cdk-blocks/hosting:CloudFrontAlarmRegionUnresolved\\]$',
);

/**
 * Run `fn` with `CDK_DEFAULT_REGION` set to `region` (`undefined` unsets it),
 * as the CDK CLI sets it for the app, and restore the previous value after.
 */
const withCliRegion = <T>(region: string | undefined, fn: () => T): T => {
  const saved = process.env.CDK_DEFAULT_REGION;
  if (region === undefined) delete process.env.CDK_DEFAULT_REGION;
  else process.env.CDK_DEFAULT_REGION = region;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.CDK_DEFAULT_REGION;
    else process.env.CDK_DEFAULT_REGION = saved;
  }
};

/** A Hosting construct in an environment-agnostic stack (no `env`), built while the CDK CLI targets `cliRegion`. */
const envAgnosticStack = (staticDir: string, cliRegion: string | undefined): Stack =>
  withCliRegion(cliRegion, () => {
    const stack = new Stack(new App(), 'TestStack');
    new HostingConstruct(stack, 'Hosting', { manifest: spaManifest(staticDir) });
    return stack;
  });

void describe('HostingConstruct — CloudFront alarm region (#481)', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- (iv) In-region: unchanged single-stack behavior ----
  void it('creates the CloudFront alarm locally in a single stack when region is us-east-1', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    new HostingConstruct(stack, 'Hosting', { manifest: spaManifest(staticDir) });

    const template = Template.fromStack(stack);
    // Alarm lives in this (us-east-1) stack.
    template.resourcePropertiesCountIs('AWS::CloudWatch::Alarm', CF_ALARM, 1);
    // No support stack was synthesized. The id carries a node-addr suffix
    // (`-CfMonitoring-<addr>`), so scan by prefix; an exact-name lookup
    // would pass even if one were wrongly synthesized.
    assert.ok(
      !app.node.children.some(
        (c) => c instanceof Stack && c.node.id.startsWith('TestStack-CfMonitoring'),
      ),
      'no us-east-1 support stack should be synthesized in-region',
    );
  });

  // ---- (i) Off-region: two stacks, CF alarm in us-east-1 stack ----
  void it('places the CloudFront alarm in a us-east-1 support stack when off-region', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'ap-northeast-1' },
    });
    new HostingConstruct(stack, 'Hosting', { manifest: spaManifest(staticDir) });

    // The regional stack has NO CloudFront alarm...
    const regional = Template.fromStack(stack);
    regional.resourcePropertiesCountIs('AWS::CloudWatch::Alarm', CF_ALARM, 0);

    // A sibling us-east-1 support stack exists and holds the alarm. Its
    // id carries a node-addr suffix so two Hosting constructs in one
    // stage don't collide, so match by prefix.
    const support = app.node.children.find(
      (c) =>
        c instanceof Stack &&
        c.node.id.startsWith('TestStack-CfMonitoring'),
    ) as Stack | undefined;
    assert.ok(support, 'expected a TestStack-CfMonitoring-* support stack');
    assert.strictEqual(support.region, 'us-east-1');

    const supportTemplate = Template.fromStack(support);
    supportTemplate.resourcePropertiesCountIs(
      'AWS::CloudWatch::Alarm',
      Match.objectLike({
        Namespace: 'AWS/CloudFront',
        MetricName: '5xxErrorRate',
        Threshold: 5,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        EvaluationPeriods: 1,
        Period: 300,
        Statistic: 'Average',
        TreatMissingData: 'notBreaching',
        Dimensions: Match.arrayWith([
          Match.objectLike({ Name: 'Region', Value: 'Global' }),
        ]),
      }),
      1,
    );
    // Its own SNS topic. No forwarder subscription — consolidation is via
    // two topics, not runtime message forwarding.
    supportTemplate.resourceCountIs('AWS::SNS::Topic', 1);
    // The us-east-1 topic ARN is surfaced by logical id.
    supportTemplate.hasOutput('MonitoringTopicArnUsEast1', Match.anyValue());
  });

  // ---- (v) Off-region: endpoint subscriptions reach BOTH topics ----
  // A single email/URL subscription entry applied to both the regional
  // and us-east-1 topics must land on each, with no synth collision.
  void it('applies email + URL subscriptions to both topics off-region', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'ap-northeast-1' },
    });

    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      monitoring: {
        subscriptions: [
          new subs.EmailSubscription('oncall@example.com'),
          new subs.UrlSubscription('https://alerts.example.com/hook'),
        ],
      },
    });

    // Regional topic carries both subscriptions.
    const regional = Template.fromStack(stack);
    regional.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'oncall@example.com',
    });
    regional.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'https',
      Endpoint: 'https://alerts.example.com/hook',
    });

    // us-east-1 support stack's topic carries them too.
    const support = app.node.children.find(
      (c) =>
        c instanceof Stack &&
        c.node.id.startsWith('TestStack-CfMonitoring'),
    ) as Stack | undefined;
    assert.ok(support, 'expected a TestStack-CfMonitoring-* support stack');
    const supportTemplate = Template.fromStack(support);
    supportTemplate.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'oncall@example.com',
    });
    supportTemplate.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'https',
      Endpoint: 'https://alerts.example.com/hook',
    });
  });

  // ---- (ii) Off-region + unresolved account → warn-and-skip ----
  // We can't build the us-east-1 support stack without a concrete account
  // (cross-region synth needs it), but hard-throwing would take down the
  // working regional alarms too. So skip ONLY the CloudFront alarm and warn
  // loudly. A visible warning is not the silent-alarm bug #481 is about.
  // (See docs/DECISIONS.md D-016.)
  void it('warns and skips the CloudFront alarm off-region when the account is unresolved (no throw)', () => {
    const staticDir = createStaticDir();
    const app = new App();
    // region resolved (off-region) but account left unresolved.
    const stack = new Stack(app, 'TestStack', {
      env: { region: 'ap-northeast-1' },
    });

    // Must NOT throw.
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    // No us-east-1 support stack was synthesized.
    assert.ok(
      !app.node.children.some(
        (c) => c instanceof Stack && c.node.id.startsWith('TestStack-CfMonitoring'),
      ),
      'no support stack should be synthesized when the account is unresolved',
    );

    // The regional alarms (e.g. SSR/DLQ) are unaffected: monitoring is
    // still on, just missing the one CloudFront alarm.
    const template = Template.fromStack(stack);
    template.resourcePropertiesCountIs('AWS::CloudWatch::Alarm', CF_ALARM, 0);

    // And the skip is loud.
    Annotations.fromStack(stack).hasWarning(
      '*',
      Match.stringLikeRegexp('Skipping the off-region CloudFront 5xx alarm'),
    );
  });

  // ---- (iii) Environment-agnostic: alarm local, level by the CLI's region ----
  // The stack does not say where it deploys, so the alarm is created in the
  // stack itself. The CDK CLI exports CDK_DEFAULT_REGION and deploys an
  // environment-agnostic stack to that same region, so that variable decides
  // how loudly synth says it.
  void it('adds an info for an environment-agnostic stack the CDK CLI deploys to us-east-1', () => {
    const stack = envAgnosticStack(createStaticDir(), 'us-east-1');

    Annotations.fromStack(stack).hasInfo('/TestStack/Hosting', REGION_UNRESOLVED_ACK_TAG);
    Annotations.fromStack(stack).hasInfo(
      '/TestStack/Hosting',
      Match.stringLikeRegexp('Deployed to any other region it will never fire'),
    );
    Annotations.fromStack(stack).hasNoWarning('*', REGION_UNRESOLVED_ACK_TAG);
    Template.fromStack(stack).resourcePropertiesCountIs('AWS::CloudWatch::Alarm', CF_ALARM, 1);
  });

  void it('synthesizes Hosting with its defaults without any warning when the CDK CLI deploys to us-east-1', () => {
    // A template's configuration, unchanged: no warning of any id (D-033).
    const stack = envAgnosticStack(createStaticDir(), 'us-east-1');
    assert.deepStrictEqual(Annotations.fromStack(stack).findWarning('*', Match.anyValue()), []);
    assert.deepStrictEqual(Annotations.fromStack(stack).findError('*', Match.anyValue()), []);
  });

  void it('warns, naming the region, when the CDK CLI deploys an environment-agnostic stack outside us-east-1', () => {
    const stack = envAgnosticStack(createStaticDir(), 'eu-west-1');

    Annotations.fromStack(stack).hasWarning('/TestStack/Hosting', REGION_UNRESOLVED_ACK_TAG);
    Annotations.fromStack(stack).hasWarning(
      '/TestStack/Hosting',
      Match.stringLikeRegexp("deploys this stack to 'eu-west-1' \\(CDK_DEFAULT_REGION\\)"),
    );
    Annotations.fromStack(stack).hasNoInfo('*', REGION_UNRESOLVED_ACK_TAG);
    Template.fromStack(stack).resourcePropertiesCountIs('AWS::CloudWatch::Alarm', CF_ALARM, 1);
  });

  void it('warns when an environment-agnostic stack is synthesized outside the CDK CLI (CDK_DEFAULT_REGION unset)', () => {
    const stack = envAgnosticStack(createStaticDir(), undefined);

    Annotations.fromStack(stack).hasWarning('/TestStack/Hosting', REGION_UNRESOLVED_ACK_TAG);
    Annotations.fromStack(stack).hasWarning(
      '/TestStack/Hosting',
      Match.stringLikeRegexp('if this app deploys outside us-east-1 the alarm will never fire'),
    );
    Annotations.fromStack(stack).hasNoInfo('*', REGION_UNRESOLVED_ACK_TAG);
    Template.fromStack(stack).resourcePropertiesCountIs('AWS::CloudWatch::Alarm', CF_ALARM, 1);
  });

  void it('synthesizes the same template whatever region the CDK CLI targets', () => {
    // CDK_DEFAULT_REGION only picks the level and text of the annotation.
    const staticDir = createStaticDir();
    const [unset, usEast1, euWest1] = [undefined, 'us-east-1', 'eu-west-1'].map((cliRegion) =>
      Template.fromStack(envAgnosticStack(staticDir, cliRegion)).toJSON(),
    );
    assert.deepStrictEqual(usEast1, unset);
    assert.deepStrictEqual(euWest1, unset);
  });

  void it('adds no environment-agnostic annotation to a stack with a resolved region', () => {
    const stack = withCliRegion('eu-west-1', () => {
      const s = new Stack(new App(), 'TestStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      new HostingConstruct(s, 'Hosting', { manifest: spaManifest(createStaticDir()) });
      return s;
    });
    Annotations.fromStack(stack).hasNoWarning('*', REGION_UNRESOLVED_ACK_TAG);
    Annotations.fromStack(stack).hasNoInfo('*', REGION_UNRESOLVED_ACK_TAG);
  });

  void it('stays silent once acknowledged on the App, at either level', () => {
    // Acknowledged after the construct, on the widest scope an app can use.
    const staticDir = createStaticDir();
    const cases = [
      ['eu-west-1', 'acknowledgeWarning'],
      ['us-east-1', 'acknowledgeInfo'],
    ] as const;
    for (const [cliRegion, acknowledge] of cases) {
      const stack = envAgnosticStack(staticDir, cliRegion);
      CdkAnnotations.of(stack.node.root)[acknowledge]('@aws-cdk-blocks/hosting:CloudFrontAlarmRegionUnresolved');
      Annotations.fromStack(stack).hasNoInfo('*', REGION_UNRESOLVED_ACK_TAG);
      Annotations.fromStack(stack).hasNoWarning('*', REGION_UNRESOLVED_ACK_TAG);
    }
  });
});
