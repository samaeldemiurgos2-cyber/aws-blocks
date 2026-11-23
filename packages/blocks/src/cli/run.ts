// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Package script entry: `node --input-type=module -e "import 'aws-cdk-blocks/run'" -- <task>`. */

// `node -e` has no script name in argv[1]. Restore the standard Node argv shape for
// in-process core functions (including telemetry), which read the actual process.argv.
process.argv.splice(1, 0, import.meta.filename);
// Imported after the splice, so the CLI reads the restored argv.
await import('./bin.js');
