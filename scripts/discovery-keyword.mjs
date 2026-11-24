// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The npm keyword every published package carries, so that
 * `npm search keywords:cdk-blocks` finds them
 * (docs/guides/extending-with-existing-aws-resources.md).
 *
 * keywords-guard.ts asserts it is present; sync-catalog.mjs leaves it out of the
 * catalog's Keywords column. Both read it from here so they agree on the tag.
 */
export const DISCOVERY_KEYWORD = 'cdk-blocks';
