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
 * evidence of death for them; proving one of those is dead needs the
 * consumers, not this repo.
 *
 * How that exemption is actually obtained matters, and is the one thing that
 * is easy to get wrong here. knip does **not** read `exports`, `bin`, `main`
 * or `module` out of a workspace's `package.json` — its only built-in entry
 * points are the two default patterns `{index,cli,main}.{ext}` and
 * `src/{index,cli,main}.{ext}`, and declaring an `entry` array for a
 * workspace **replaces** those defaults rather than adding to them. So a
 * workspace that declares `entry` at all must re-declare every entry its
 * manifest implies — each target of its `exports` map, each `bin` target,
 * `main`/`module` — or its whole public surface reads as dead and every
 * internal symbol only that surface reaches cascades into the report. That
 * is exactly how this config drifted: 6 dead files and ~450 phantom unused
 * exports, all of them entries that had simply stopped being declared.
 *
 * Practical rule when adding a workspace below: open its `package.json`
 * first, and enumerate. The `!` suffix marks a production entry, which is
 * what a published export map and a `bin` are; test entries carry no `!`.
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
    // The root manifest is private and declares no `exports`, `bin` or
    // `main`, so there are no manifest entries to re-declare here.
    ".": {
      entry: [
        ...TEST_ENTRY,
        // Operator backstops, documented in docs/architecture/FILES.md and
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
        // Manifest `module`: the Hono server itself, run by `bun --hot
        // apps/api/src/index.ts` (the workspace `dev` script) and by the
        // Docker image CMD.
        "src/index.ts!",
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
        "src/cli.ts!",
        ...TEST_ENTRY,
        // Compiled and executed by the "Smoke-test keyring native binding"
        // step of .github/workflows/release.yml.
        "scripts/ci-keyring-probe.ts",
      ],
    },

    // Private SPA: no `exports`/`bin`/`main`, and its browser entry is
    // reached from index.html by the Vite plugin, not from this list.
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
        // Every target of the `exports` map — the workspace consumers
        // (apps/api, apps/cli, the modules) import these subpaths by name.
        "src/schema/index.ts!",
        "src/run-status.ts!",
        "src/pricing-status.ts!",
        "src/client.ts!",
        "src/auth.ts!",
        "src/auth-policy.ts!",
        "src/bootstrap-org.ts!",
        "src/storage.ts!",
        "src/notify.ts!",
        ...TEST_ENTRY,
        // Migration CLI, invoked as `bun packages/db/src/migrate.ts`.
        "src/migrate.ts",
      ],
    },

    "packages/mcp-transport": {
      entry: [
        // Sole `exports` target, imported as `@appstrate/mcp-transport`.
        "src/index.ts!",
        ...TEST_ENTRY,
        // Spawned as a subprocess by the transport tests.
        "test/fixtures/echo-server.ts",
      ],
    },

    "packages/afps-runtime": {
      entry: [
        // Every target of the `exports` map: published on npm, so out-of-tree
        // readers reach these subpaths directly.
        "src/index.ts!",
        "src/cli/index.ts!",
        "src/errors.ts!",
        "src/interfaces/index.ts!",
        "src/types/index.ts!",
        "src/events/index.ts!",
        "src/sinks/index.ts!",
        "src/template/index.ts!",
        "src/transport/trace-context.ts!",
        "src/bundle/index.ts!",
        "src/runner/index.ts!",
        "src/resolvers/index.ts!",
        "src/conformance/index.ts!",
        // Manifest `bin`: the `afps` executable itself.
        "bin/afps.ts!",
        ...TEST_ENTRY,
        "examples/**/build.ts",
      ],
    },

    // Modules: the `exports` map is what the module loader resolves when a
    // `MODULES` specifier names the package, and what apps/web imports for
    // the UI surface. Plus the per-module truncate list, auto-discovered by
    // the root test preload.
    "packages/module-chat": {
      entry: [
        "src/index.ts!",
        "src/ui/index.tsx!",
        "src/ui/use-sessions.ts!",
        ...TEST_ENTRY,
        "test/tables.ts",
      ],
    },
    "packages/module-claude-code": {
      entry: ["src/index.ts!", ...TEST_ENTRY, "test/tables.ts"],
    },
    "packages/module-codex": {
      entry: ["src/index.ts!", ...TEST_ENTRY, "test/tables.ts"],
    },
    "packages/module-observability": {
      entry: ["src/index.ts!", ...TEST_ENTRY, "test/tables.ts"],
    },

    "packages/core": {
      // Every target of the `exports` map. Published on npm and consumed out
      // of tree (cloud, connect-helper, third-party modules), so each subpath
      // is a public entry whose readers this repo cannot see.
      entry: [
        "src/image-ref.ts!",
        "src/logger.ts!",
        "src/env.ts!",
        "src/ajv.ts!",
        "src/api-errors.ts!",
        "src/safe-json.ts!",
        "src/storage.ts!",
        "src/storage-s3.ts!",
        "src/storage-fs.ts!",
        "src/errors.ts!",
        "src/validation.ts!",
        "src/integration.ts!",
        "src/mcp-server.ts!",
        "src/mcp-server-meta.ts!",
        "src/mcp-server-bundle/index.ts!",
        "src/zip.ts!",
        "src/package-files.ts!",
        "src/naming.ts!",
        "src/mime.ts!",
        "src/dependencies.ts!",
        "src/integrity.ts!",
        "src/semver.ts!",
        "src/dist-tags.ts!",
        "src/version-policy.ts!",
        "src/system-packages.ts!",
        "src/runtime-tools-catalog.ts!",
        "src/runtime-tool-defs.ts!",
        "src/runtime-event-drain.ts!",
        "src/ssrf.ts!",
        "src/sse.ts!",
        "src/html.ts!",
        "src/schemas.ts!",
        "src/schema-validation.ts!",
        "src/form.ts!",
        "src/format.ts!",
        "src/module.ts!",
        "src/telemetry.ts!",
        "src/permissions.ts!",
        "src/platform-types.ts!",
        "src/token-usage.ts!",
        "src/token-budget.ts!",
        "src/sidecar-types.ts!",
        "src/model-swap.ts!",
        "src/model-generation.ts!",
        "src/pairing-token.ts!",
        "src/jwt.ts!",
        "src/dedupe-label.ts!",
        "src/chat-contract.ts!",
        "src/file-uri.ts!",
        "src/chat-turn-metadata.ts!",
        "src/bearer.ts!",
        "src/oauth-bearer-swap.ts!",
        "src/url.ts!",
        "src/run-and-wait-client.ts!",
        ...TEST_ENTRY,
      ],
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

    // Docker entrypoints: the image CMD runs them directly. Neither manifest
    // declares `exports`, `bin` or `main`.
    "runtime-pi": { entry: ["entrypoint.ts!", ...TEST_ENTRY] },
    "runtime-pi/sidecar": {
      entry: ["server.ts!", ...TEST_ENTRY, "test/fixtures/**/server.ts"],
    },

    // Every target of the `exports` map. afps-shared is published on npm
    // (core resolves it by range); the rest are workspace-internal libraries
    // whose consumers import the subpath by name.
    "packages/afps-shared": {
      entry: [
        "src/companion-files.ts!",
        "src/semver-resolve.ts!",
        "src/integrity.ts!",
        "src/credential-template.ts!",
        "src/delivery-http.ts!",
        "src/api-tool-naming.ts!",
        "src/mcp-naming.ts!",
        "src/file-field.ts!",
        "src/ssrf.ts!",
        "src/token-usage.ts!",
        "src/ssrf-dns.ts!",
        "src/guarded-fetch.ts!",
        "src/signed-token.ts!",
        "src/unzip-bounded.ts!",
        "src/backoff.ts!",
        "src/mime.ts!",
        ...TEST_ENTRY,
      ],
    },
    "packages/connect": {
      entry: [
        "src/index.ts!",
        "src/connect/index.ts!",
        "src/proxy-primitives.ts!",
        "src/proxy-ca-planner.ts!",
        "src/integration-mitm-planner.ts!",
        "src/integration-credentials.ts!",
        "src/afps-delivery.ts!",
        ...TEST_ENTRY,
      ],
    },
    "packages/emails": { entry: ["src/index.ts!", ...TEST_ENTRY] },
    "packages/env": { entry: ["src/index.ts!", ...TEST_ENTRY] },
    "packages/runner-pi": {
      entry: [
        "src/index.ts!",
        "src/runtime-tools/index.ts!",
        "src/provider-map.ts!",
        ...TEST_ENTRY,
      ],
    },
    "packages/shared-types": { entry: ["src/index.ts!", ...TEST_ENTRY] },
    "packages/ui": {
      entry: [
        "src/schema-form/index.tsx!",
        "src/components/sidebar-context.ts!",
        "src/components/model-generation-labels.ts!",
        // Wildcard subpath `./components/*` — apps/web imports design-system
        // components one file at a time.
        "src/components/*.tsx!",
        "src/cn.ts!",
        "src/use-mobile.ts!",
        ...TEST_ENTRY,
      ],
    },
    // Playwright specs, discovered by the runner, not imported.
    e2e: { entry: ["**/*.spec.ts", ...TEST_ENTRY] },
  },
};

export default config;
