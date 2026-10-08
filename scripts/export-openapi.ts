// SPDX-License-Identifier: Apache-2.0

/**
 * Write the OpenAPI document of this checkout to a file.
 *
 * The public API reference (docs/web) is generated from it at build time, so
 * the site documents the commit it is built from rather than whatever a live
 * instance happens to run. The document is assembled exactly like
 * `generate-api-types.ts` assembles it: the core spec plus the contribution of
 * every module in the tree, found on the filesystem (not through `MODULES`),
 * which is also the operation set the production instance serves.
 *
 * `@appstrate/env` validates its required secrets the moment the API's logger
 * is imported, although nothing here reads them. Missing ones get inert
 * placeholders so the script runs from a bare checkout (CI, docs/web) without
 * an `.env`; values already in the environment are left alone. Importing the
 * modules also opens the embedded database (PGlite) when `DATABASE_URL` is
 * unset; it is pointed at a throwaway directory so the export leaves no
 * `data/pglite` behind in the caller's working directory.
 *
 * Usage: bun scripts/export-openapi.ts <output.json>
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLACEHOLDER_SECRETS: Record<string, string> = {
  BETTER_AUTH_SECRET: "docs-build-placeholder",
  UPLOAD_SIGNING_SECRET: "docs-build-placeholder",
  RUN_TOKEN_SECRET: "docs-build-placeholder",
  CONNECT_SESSION_SECRET: "docs-build-placeholder",
  CONNECTION_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

const output = process.argv[2];
if (!output) {
  process.stderr.write("usage: bun scripts/export-openapi.ts <output.json>\n");
  process.exit(1);
}

for (const [name, value] of Object.entries(PLACEHOLDER_SECRETS)) {
  process.env[name] ??= value;
}
const scratchDb =
  !process.env.DATABASE_URL && !process.env.PGLITE_DATA_DIR
    ? join(tmpdir(), `appstrate-export-openapi-${process.pid}`)
    : null;
if (scratchDb) process.env.PGLITE_DATA_DIR = scratchDb;

// Imported after the placeholders are set: the env schema runs at import time.
const { buildOpenApiSpec } = await import("../apps/api/src/openapi/index.ts");
const { collectModuleOpenApi } = await import("./lib/module-openapi.ts");

const { paths, componentSchemas, tags } = await collectModuleOpenApi();
const spec = buildOpenApiSpec(paths, componentSchemas, tags);
await Bun.write(output, `${JSON.stringify(spec, null, 2)}\n`);

process.stdout.write(
  `OpenAPI ${spec.openapi}: ${Object.keys(spec.paths).length} paths -> ${output}\n`,
);
if (scratchDb) rmSync(scratchDb, { recursive: true, force: true });
// Importing the modules opens handles (timers, pools) that would keep the
// process alive; the document is written, so leave.
process.exit(0);
