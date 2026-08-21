// SPDX-License-Identifier: Apache-2.0

import type { KnipConfig } from "knip";

/**
 * Dead-code gate — issue #1181.
 *
 * `no-unused-vars` only sees locals: an exported symbol is "used" by
 * construction, so nothing in the `check` chain answered "does this exported
 * symbol still have a reader". That blind spot is how #1178 accumulated
 * months of dead weight invisibly. knip answers it, and covers dead files and
 * unused dependencies in the same pass.
 *
 * Two rules for anything added below:
 *
 *   1. An `entry` is a file something *outside the import graph* runs or
 *      loads — a Docker entrypoint, a CI step, a glob-discovered fixture, an
 *      operator script. Justify it with **what reaches it**.
 *   2. An `ignore*` is a false positive knip structurally *cannot* see — a
 *      dynamic import, an npm contract, a wire format. Justify it with **why
 *      knip is blind**, never with "it is fine".
 *
 * Anything that is neither is dead, and gets deleted instead of listed.
 *
 * Not covered, deliberately: whether a **published** package's public export
 * still has a reader. `@appstrate/core`, `@appstrate/afps-runtime` and the
 * `@appstrate/module-*` packages are consumed out of tree (cloud,
 * connect-helper, third-party modules), so "no in-repo reader" is not
 * evidence of death for them. knip treats every name in their `exports` map
 * as an entry, which is the correct default; proving one of those is dead
 * needs the consumers, not this repo.
 */

/**
 * The suite runs on `bun test`, for which knip has no plugin, so no test file
 * is ever pulled into the import graph. Without this every test file — and
 * every helper only tests import — reads as dead.
 */
const TEST_ENTRY = [
  "test/**/*.test.ts",
  "test/**/*.test.tsx",
  "src/**/test/**/*.test.ts",
  "src/**/*.test.ts",
];

const config: KnipConfig = {
  /**
   * Invoked through `npx`/`bunx` or a shell builtin, so no manifest lists
   * them: `playwright` (e2e job + `test:e2e` script), `which`/`mktemp`
   * (POSIX utilities called from scripts and one test).
   */
  ignoreBinaries: ["playwright", "which", "mktemp"],

  /**
   * `duplicates` reports two exported names bound to one value. Every hit is
   * a deliberate, documented alias (`CONSOLE_ID_RE = RUN_ID_RE` records that
   * a console id *is* a run id; `seedAgent = seedPackage` reads better at the
   * call site), not an accident worth failing a build over.
   */
  exclude: ["duplicates"],

  workspaces: {
    ".": {
      entry: [
        ...TEST_ENTRY,
        // Operator backstops, documented in docs/architecture/DOCUMENTS.md and
        // CHANGELOG.md respectively. Run by hand, never imported.
        "scripts/storage-orphans.ts",
        "scripts/audit-empty-integration-selections.ts",
        // Dev utility that mints a CONFORMANCE_TOKENS bearer, documented in
        // its own header.
        "scripts/conformance/grab-token.ts",
        // One-shot data migration for the manifest `config` -> `input` collapse,
        // run by hand per deployment (CHANGELOG.md and the header of
        // packages/db/drizzle/0040_config_into_input.sql both point at it).
        "scripts/migrate-config-to-input.ts",
        // System-package sources: `build:system-packages` reads them off disk
        // and bundles them, so nothing imports them.
        "scripts/system-packages/**/server/index.ts",
        // Documentation examples, compiled by their own README instructions.
        "examples/**/*.ts",
      ],
      // The examples illustrate what a *consumer* writes; the SDK they import
      // is deliberately not a dependency of this repo's root manifest.
      ignoreDependencies: ["@earendil-works/pi-coding-agent"],
    },

    "apps/api": {
      entry: [
        ...TEST_ENTRY,
        // Built-in modules are loaded by name out of the `MODULES` env var,
        // never statically imported.
        "src/modules/*/index.ts",
        // Per-module truncate lists, auto-discovered by the root test preload.
        "src/modules/*/test/tables.ts",
        // Run inside the guest VM / on the Firecracker host, not by the API.
        "src/modules/firecracker/guest/supervisor.ts",
        "src/modules/firecracker/runner/daemon.ts",
        "src/modules/firecracker/scripts/dev/smoke.ts",
      ],
      // Same dynamic `MODULES` load: declared so the workspace resolves, but
      // no import statement names them.
      ignoreDependencies: [
        "@appstrate/module-chat",
        "@appstrate/module-codex",
        "@appstrate/module-observability",
      ],
    },

    "apps/cli": {
      entry: [
        // Bundled to dist/cli.js by scripts/build.ts; `bin` points at the
        // build output, which knip cannot walk back to a source file.
        "src/cli.ts",
        ...TEST_ENTRY,
        // Compiled and executed by the "Smoke-test keyring native binding"
        // step of .github/workflows/release.yml.
        "scripts/ci-keyring-probe.ts",
      ],
    },

    "apps/web": {
      entry: [
        ...TEST_ENTRY,
        // Type-level guard over the generated OpenAPI types: it exists to be
        // type-checked, so it has no importer by design.
        "src/api/schema.assert.ts",
      ],
    },

    "packages/db": {
      entry: [
        ...TEST_ENTRY,
        // Migration CLI, invoked as `bun packages/db/src/migrate.ts`.
        "src/migrate.ts",
      ],
    },

    "packages/mcp-transport": {
      entry: [
        ...TEST_ENTRY,
        // Spawned as a subprocess by the transport tests.
        "test/fixtures/echo-server.ts",
      ],
    },

    "packages/afps-runtime": {
      entry: [...TEST_ENTRY, "examples/**/build.ts"],
    },

    // Per-module truncate lists, auto-discovered by the root test preload.
    "packages/module-chat": { entry: [...TEST_ENTRY, "test/tables.ts"] },
    "packages/module-claude-code": { entry: [...TEST_ENTRY, "test/tables.ts"] },
    "packages/module-codex": { entry: [...TEST_ENTRY, "test/tables.ts"] },
    "packages/module-observability": { entry: [...TEST_ENTRY, "test/tables.ts"] },

    "packages/core": {
      entry: [...TEST_ENTRY],
      /**
       * Optional peer dependencies: the S3 storage adapter and the Hono
       * middleware are imported behind a runtime feature check, and hosts that
       * do not use them never install them. knip sees the import but no
       * regular dependency entry.
       */
      ignoreDependencies: [
        "@aws-sdk/client-s3",
        "@aws-sdk/lib-storage",
        "@aws-sdk/s3-request-presigner",
        "hono",
      ],
    },

    // Docker entrypoints: the image CMD runs them directly.
    "runtime-pi": { entry: ["entrypoint.ts", ...TEST_ENTRY] },
    "runtime-pi/sidecar": {
      entry: ["server.ts", ...TEST_ENTRY, "test/fixtures/**/server.ts"],
    },

    "packages/afps-shared": { entry: [...TEST_ENTRY] },
    "packages/connect": { entry: [...TEST_ENTRY] },
    "packages/emails": { entry: [...TEST_ENTRY] },
    "packages/env": { entry: [...TEST_ENTRY] },
    "packages/runner-pi": { entry: [...TEST_ENTRY] },
    "packages/shared-types": { entry: [...TEST_ENTRY] },
    "packages/ui": { entry: [...TEST_ENTRY] },
    e2e: { entry: ["**/*.spec.ts", ...TEST_ENTRY] },
  },
};

export default config;
