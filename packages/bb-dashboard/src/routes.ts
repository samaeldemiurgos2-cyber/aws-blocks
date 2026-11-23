// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Route registration for the Dashboard BB.
 *
 * Mounts a single GET route that 302-redirects to the CloudWatch Dashboard
 * console URL. Each dashboard mounts its own route with its own URL: the AWS
 * runtime derives it from the region and the dashboard's name (see
 * `naming.ts`). A `null` URL (no region known) makes the route answer 503.
 * The mock does not use this route; it serves a local page instead.
 */

import { RawRoute, type BlocksContext } from '@aws-cdk-blocks/core';
import type { ScopeParent } from '@aws-cdk-blocks/core';

/**
 * Mount the dashboard redirect route on the given scope.
 *
 * @param scope - Parent scope to register the RawRoute on.
 * @param routePath - HTTP path for the redirect (e.g., '/cdk-blocks/dashboard').
 * @param dashboardUrl - This dashboard's console URL; null means no region is known,
 *   and the route answers 503.
 */
export function mountDashboardRoute(
	scope: ScopeParent,
	routePath: string,
	dashboardUrl: string | null,
): void {
	new RawRoute(scope, 'dashboard-redirect', {
		method: 'GET',
		path: routePath,
		handler: async (ctx: BlocksContext) => {
			// The URL is fixed per dashboard at construction; an app with several
			// dashboards has one route per dashboard, each with its own URL.
			const url = dashboardUrl;
			if (!url) {
				ctx.response.status = 503;
				ctx.response.headers.set('Content-Type', 'application/json');
				ctx.response.send({
					message: 'Dashboard BB - CloudWatch Dashboards are a cloud-only resource.',
					hint: 'Run `npx cdk deploy` to create the dashboard in AWS.',
					localObservability: {
						logs: 'Check your terminal output - Logger BB writes structured JSON to stdout',
						metrics: 'Metrics BB writes EMF-formatted JSON to stdout (visible in terminal)',
						traces: 'Tracer stores mock traces to .cdk-blocks/local/data/ and logs them to stdout',
					},
				});
				return;
			}
			ctx.response.status = 302;
			ctx.response.headers.set('Location', url);
			ctx.response.send('');
		},
	});
}
