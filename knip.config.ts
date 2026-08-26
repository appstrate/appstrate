// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
 * still has a reader. `@appstrate/core` and `@appstrate/afps-shared` are on npm
 * and consumed out of tree (`cloud`, `connect-helper`, third-party modules), so
 * "no in-repo reader" is not evidence of death for them; proving one of those
 * is dead needs the consumers, not this repo.
 *
 * That list used to read "`@appstrate/core`, `@appstrate/afps-runtime` and the
 * `@appstrate/module-*` packages", and for five of those six it was simply
 * false — which is not a cosmetic error, because the exemption below is granted
 * on the strength of it. **Only two scoped packages in this monorepo have ever
 * been published**: `@appstrate/core` and `@appstrate/afps-shared`, the only two
 * with a publish workflow (`publish-core.yml`, `publish-afps-shared.yml`) and a
 * release tag. `@appstrate/afps-runtime` carries `publishConfig` but has no
 * workflow, no `afps-runtime@*` tag, and npm holds one `0.0.0` placeholder from
 * 2026-04-20 against a local 0.2.0; `@appstrate/runner-pi` and all four
 * `@appstrate/module-*` packages are absent from npm entirely and are reached
 * in-tree by `workspace:*` or by a `MODULES` specifier the loader resolves by
 * name. `@appstrate/ui` is a third case: `"private": true` here, yet 1.0.1 sits
 * on npm from before that flag — treated as private below, which is the strict
 * direction.
 *
 * The cost of the wrong premise is measurable: two exports in
 * `packages/afps-runtime/src/resolvers/bundle-adapter.ts`
 * (`readPackageText` / `readPackageBytes`) sat dead behind it, documented as
 * sparing duplication "every resolver would otherwise duplicate" while no
 * resolver called either. Found by hand, not by this gate. Verify publication
 * before granting the exemption to anything else — `npm view <pkg> versions`
 * and `ls .github/workflows/publish-*`, not the manifest's `publishConfig`.
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
 * That re-declaration is no longer written by hand. `manifestEntries()` below
 * reads the workspace's `package.json` and derives it, so a manifest edit
 * cannot silently desynchronise from this file. What stays hand-written is
 * the other half — the entries no manifest implies (Docker CMDs, test
 * fixtures, operator scripts) — and those still need the "what reaches it"
 * justification rule 1 asks for.
 */

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * The `entry` patterns a workspace's `package.json` implies: every target of
 * its `exports` map (walking conditional and array forms), every `bin`
 * target, and `main`/`module`. Each is emitted with the `!` suffix that marks
 * a production entry — an export map and a `bin` are exactly that.
 *
 * `omitExports` drops an `exports` **key** from the derivation. It exists for
 * the one case where a manifest target must deliberately not be an entry, and
 * every use of it carries the reason at the call site. It takes the subpath
 * key rather than the file pattern so that a manifest retarget does not
 * silently re-add what was omitted on purpose.
 */
function manifestEntries(workspace: string, omitExports: readonly string[] = []): string[] {
  const manifest = JSON.parse(
    readFileSync(resolve(ROOT, workspace, "package.json"), "utf8"),
  ) as Partial<Record<"main" | "module" | "bin" | "exports", unknown>>;

  const targets: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") targets.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(collect);
  };

  collect(manifest.main);
  collect(manifest.module);
  collect(manifest.bin);
  if (manifest.exports !== null && typeof manifest.exports === "object") {
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (!omitExports.includes(subpath)) collect(target);
    }
  } else {
    collect(manifest.exports);
  }

  return [...new Set(targets.map((target) => `${target.replace(/^\.\//, "")}!`))];
}

/**
 * Test files are **not** declared here. knip ships a Bun plugin that reads
 * each workspace's `test` script and turns it into entry patterns: a bare
 * `bun test` yields a recursive `.test.` / `.spec.` glob over the workspace,
 * and `bun test <dir>` yields the same glob rooted at `<dir>`. Every
 * workspace that runs tests declares such a script, so its suites — and the
 * helpers only they import — are already in the graph.
 *
 * A blanket list of test globs applied to every workspace is worse than
 * nothing: most of the patterns match no file in most workspaces, and knip
 * reports each one as a configuration hint. 65 of those hints is where a
 * *stale* entry hides, and a stale entry is what cost this config 6 dead
 * files and ~450 phantom unused exports. knip reports such a pattern as a
 * configuration hint, which is advisory — see the note on
 * `treatConfigHintsAsErrors` below for why it is NOT escalated to an error.
 *
 * The one gap the plugin leaves is called out at `apps/api` below.
 */

/**
 * `includeEntryExports` — why eight workspaces below set it and the rest do
 * not.
 *
 * knip does not report the exports of an entry file: reaching a file as an
 * entry marks everything it exports as used (`isReferenced`,
 * knip/dist/graph-explorer/operations/is-referenced.js). That is exactly
 * right for a **published** package, whose readers live out of tree — and
 * exactly wrong for a private one, because the mechanism this config uses to
 * obtain that exemption (declaring every `exports` target as an entry) is
 * structural: it applies to any workspace with an export map, published or
 * not.
 *
 * The line is therefore drawn at "private workspace WITH an `exports` map":
 * `packages/db`, `packages/ui`, `packages/connect`, `packages/emails`,
 * `packages/env`, `packages/shared-types` and `packages/mcp-transport`. All
 * seven are `"private": true` with only in-repo consumers, so "no in-repo
 * reader" *is* evidence of death for them and the exemption is unearned. They
 * opt back in; doing so the first time reported 36 unused exports and 38
 * unused exported types the gate had been structurally unable to see.
 *
 * `apps/api` and `apps/web` are private too, and deliberately NOT in that
 * list: neither declares an `exports` map, so the exemption above is not what
 * is happening to them. Every entry they declare is a file something outside
 * the import graph runs — a Docker CMD, a `MODULES` specifier the loader
 * resolves by name, a `test/tables.ts` the root preload reaches with a
 * computed `await import()` (test/setup/preload.ts:342), a type-level guard
 * that exists only to be typechecked. Turning the flag on for them reported
 * exactly five module `default`s and three types, all of them those cases,
 * and suppressing them would have taken glob-wide `ignoreIssues` over
 * `src/modules/*` — wider than the noise it removed, and blind to the real
 * dead named export it was supposed to catch.
 *
 * It stays off for `packages/core` and `packages/afps-shared`, which are
 * genuinely published and genuinely read out of tree, and for the workspaces
 * whose only entries are Docker CMDs or Playwright specs, which export nothing.
 *
 * `packages/runner-pi` is the eighth, and it got there by the triage below
 * rather than by the `exports`-map rule: it is not on npm, so "no in-repo
 * reader" is evidence of death for it too. Turning the flag on reported 15
 * findings, every one a type re-exported from `src/index.ts` beside its own
 * function and named by nobody outside the package — options and payload
 * shapes consumers build as object literals. All 15 lines were deleted (the
 * types stay exported from their own modules), and the run is clean, so this
 * workspace carries no `ignore*` from the change. Small enough to settle in
 * place, unlike the deferral below.
 *
 * It ALSO stays off, for now, for `packages/afps-runtime`, `apps/cli` and the
 * four `packages/module-*` packages — and that is a DEFERRAL, not the exemption
 * above: per the header, none of them is on npm, so each has the same unearned
 * exemption `packages/ui` and its six siblings gave up. The flag was measured
 * on `packages/afps-runtime` (176 findings, 122 distinct names, 159 of them
 * barrel re-export lines) and the result is not a hygiene list — it is the
 * single question of whether an unpublished package keeps a portable public
 * API, which belongs to its own pass. See that workspace's block below for the
 * numbers. Do not grant these the published-package exemption on re-reading
 * this file; they are owed a triage, not a pass.
 */

const config: KnipConfig = {
  /**
   * `treatConfigHintsAsErrors` is deliberately NOT set, and this note is the
   * evidence for that rather than a preference.
   *
   * It *was* set here, and it made `verify:dead-code` fail on Linux while
   * passing on macOS — same lockfile, same knip 5.88.1: zero configuration
   * hints locally, 120 in CI. Every one of the 120 was `entry-redundant`
   * ("this entry is already reachable another way"), not the `entry-empty`
   * staleness this config actually cares about, and knip's option is a single
   * boolean covering all fifteen hint types (`ConfigurationHintType`,
   * knip/dist/types/issues.d.ts) — there is no way to escalate one without
   * the other.
   *
   * Redundancy is a judgement about knip's own module resolution, and that
   * judgement moved with the host. Deleting the patterns it flags is not the
   * fix either: they read as redundant only where knip reaches them some
   * other way, so on a host where it does not, dropping them reintroduces
   * exactly the drift described above. A gate that reports 120 problems on
   * one OS and none on another is not measuring this repo, and does not get
   * to block a merge.
   *
   * What issue #1181 asked for is unaffected. Unused files, unused exports
   * and unused dependencies are knip *issues*, not hints: they fail the run
   * on their own, and they agreed across both hosts (CI reported none). Hints
   * still print on every run — they are read, not obeyed.
   */

  /**
   * An exported `interface` whose only reference is inside its own file is
   * the *shape* of something else that file exports — the parameter of an
   * exported function, its return type, the type of an exported const. It is
   * part of that declaration's contract, not an independent export, and
   * un-exporting it to quiet this gate is forbidden (AGENTS.md). Enabling the
   * flag for `interface` drops 24 such findings and changes nothing else.
   *
   * `type` is deliberately NOT enabled alongside it, and that asymmetry is
   * the point: knip counts a bare `export type { X } from "./y"` re-export as
   * a use of `X` within the re-exporting file, so `type: true` would silence
   * every dead type-only barrel re-export — 27 of which this config's first
   * green run found and deleted. The handful of `type` aliases genuinely in
   * the `interface` position carry a `@typeContract` tag instead (below).
   */
  ignoreExportsUsedInFile: { interface: true },

  /**
   * Per-symbol carve-outs, tagged at the declaration so the reason travels
   * with the code instead of drifting in a glob here. Two tags exist, and a
   * new use of either MUST carry its own prose justification at the site:
   *
   *   `@openapiMirror` — the export is reached BY NAME, never by an import.
   *     `verify:openapi` step #7 resolves it out of the *string*
   *     `sharedTypeName` in `apps/api/src/openapi/response-type-registry.ts`
   *     through the TypeScript Compiler API, and
   *     `scripts/lib/ts-interface-required-keys.ts` fails the gate if the
   *     name stops being exported. knip sees a string literal, not an edge.
   *
   *   `@typeContract` — the `type`-alias half of the `ignoreExportsUsedInFile`
   *     rule above: a `type` that is the shape of another export in the same
   *     file, which callers read by inference and never name.
   *
   *     What that covers narrowed at knip 6. Through knip 5 it also covered
   *     the parameter and return types of an exported function; knip 6 counts
   *     that use on its own, and reported the three tags carrying it
   *     (`RealmResolver`, `CreateBootstrapOrgResult`, `SignupPolicyDecision`,
   *     all in `packages/db`) as suppressing nothing, so they were dropped —
   *     a carve-out that suppresses nothing is drift, not insurance. What
   *     knip 6 still does NOT count is a `type` named only as an ARM of an
   *     exported union in the same file (`ConnectionUpdateEvent` and
   *     `ChatSessionUpdateEvent` in `packages/shared-types`, arms of
   *     `RealtimeEvent`, which every consumer reaches by narrowing on
   *     `event`), or one named only inside another tagged type
   *     (`SignupBlockReason`). Those are what the tag holds today.
   */
  tags: ["-openapiMirror", "-typeContract"],

  /**
   * `packages/ui/src/components/*.tsx` holds vendored shadcn/ui component
   * families, copied in whole and re-exported in whole. A family is
   * correct-by-construction: `DialogPortal`/`DialogOverlay`/`DialogClose` ship
   * with `Dialog` whether or not this app renders each one today, and pruning
   * them would fight the next `shadcn add` diff for no gain. Only the
   * `exports` issue type is suppressed — a component FILE nothing imports is
   * still reported, which is the whole reason the `./components/*` wildcard
   * was dropped from the `packages/ui` entry list below.
   */
  ignoreIssues: { "packages/ui/src/components/*.tsx": ["exports"] },

  /**
   * Invoked through `npx`/`bunx` or a shell builtin, so no manifest lists
   * them: `playwright` (e2e job + `test:e2e` script), `which`/`mktemp`
   * (POSIX utilities called from scripts and one test).
   *
   * knip 6 reports `playwright` and `which` as redundant here — it now
   * resolves `npx playwright` back to the `@playwright/test` dependency, and
   * treats `which` as a system binary. Both stay: that resolution is exactly
   * the host-dependent judgement the note on configuration hints above says
   * is read rather than obeyed, and a wrong deletion fails the gate on the
   * host that resolves differently. `mktemp` draws no hint at all.
   *
   * `setpriv` is a fourth case, and not the same one: it is not invoked from
   * a script at all. `apps/api/src/modules/firecracker/guest/supervisor.ts`
   * spawns it INSIDE the Firecracker guest rootfs, where util-linux provides
   * it — it is a property of the guest image, not of this repo's toolchain,
   * and no host running `bun run check` needs it installed. knip 6 reads
   * `spawn()` call sites as binary uses, which knip 5 did not, so this entry
   * arrived with that bump rather than with the code.
   */
  ignoreBinaries: ["playwright", "which", "mktemp", "setpriv"],

  /**
   * `duplicates` reports two exported names bound to one value. Every hit is
   * a deliberate, documented alias (`CONSOLE_ID_RE = RUN_ID_RE` records that
   * a console id *is* a run id; `seedAgent = seedPackage` reads better at the
   * call site), not an accident worth failing a build over.
   */
  exclude: ["duplicates"],

  workspaces: {
    // The root manifest is private and declares no `exports`, `bin` or
    // `main`, so `manifestEntries` derives nothing for it.
    ".": {
      entry: [
        ...manifestEntries("."),
        // Dev utility that mints a CONFORMANCE_TOKENS bearer, documented in
        // its own header. Run by hand and by hand only — unlike the two
        // operator backstops (`scripts/storage-orphans.ts`,
        // `scripts/audit-empty-integration-selections.ts`) it has no `bun run`
        // script, so nothing derives it and it has to be named here.
        //
        // Those two backstops used to be listed alongside it, from a time when
        // they had no package.json entry either — which made the exemption a
        // claim about a script nothing could invoke, 800 lines kept alive by
        // the list that was supposed to justify keeping them. They have
        // `audit:storage-orphans` / `audit:empty-integrations` now, knip's Bun
        // plugin derives an entry from each, and it flagged the duplicate
        // declarations as redundant. Deleting them is not the usual
        // entry-redundant trap described below: that trap is about knip
        // reaching a file through module *resolution*, which moves with the
        // host, whereas this reachability is read straight out of
        // package.json. Delete the `bun run` script and the file goes back to
        // being reported as unused — which is the claim we wanted anchored.
        "scripts/conformance/grab-token.ts",
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
        ...manifestEntries("apps/api"),
        // Built-in modules are loaded by name out of the `MODULES` env var,
        // never statically imported.
        "src/modules/*/index.ts",
        // Per-module truncate lists, auto-discovered by the root test preload.
        "src/modules/*/test/tables.ts",
        // The workspace `test` script names only `test/unit/` and
        // `test/integration/`, so knip's Bun plugin derives its entry
        // patterns from those two directories alone and never reaches the
        // suites the built-in modules keep next to their own source. The
        // root `bun test` does run them.
        "src/modules/*/test/**/*.test.ts",
        // Run inside the guest VM / on the Firecracker host, not by the API.
        "src/modules/firecracker/guest/supervisor.ts",
        "src/modules/firecracker/runner/daemon.ts",
        "src/modules/firecracker/scripts/dev/smoke.ts",
      ],
      /**
       * Same dynamic `MODULES` load: declared so the workspace resolves, but
       * no import statement names them, so knip reports each as an unused
       * dependency. Deleting one on that report is not hypothetical — it has
       * happened, and only the health-container e2e caught it.
       *
       * Written as one alternation rather than four literals because knip
       * compiles any ignore entry containing `(`, `|`, `*`, `+`, `{`, `^` or
       * `$` to a RegExp, and reports an entry that never suppressed anything
       * as a configuration hint. `@appstrate/module-claude-code` is in that
       * position today: it is loaded exactly like its three siblings, but one
       * unit test (`test/unit/services/model-selection.test.ts`) imports it
       * statically to assert the claude-code model lists, so knip already
       * sees a reader and would call a literal entry redundant. It is not —
       * the day that assertion moves, the dependency reads as dead. The
       * alternation covers it without asserting anything untrue, and stays
       * exact: a new module dependency is not silently covered, it has to be
       * named here.
       */
      ignoreDependencies: ["@appstrate/module-(chat|claude-code|codex|observability)"],
    },

    // The one workspace whose entries are NOT derived from its manifest:
    // `bin` points at ./dist/cli.js, a build artifact that does not exist in
    // a clean checkout and that knip cannot walk back to a source file.
    "apps/cli": {
      entry: [
        // Bundled to dist/cli.js by scripts/build.ts; `bin` points at the
        // build output, which knip cannot walk back to a source file.
        "src/cli.ts!",
        // Compiled and executed by the "Smoke-test keyring native binding"
        // step of .github/workflows/release.yml.
        "scripts/ci-keyring-probe.ts",
      ],
    },

    // Private SPA: no `exports`/`bin`/`main`, and its browser entry is
    // reached from index.html by the Vite plugin, not from this list.
    "apps/web": {
      entry: [
        ...manifestEntries("apps/web"),
        // Type-level guard over the generated OpenAPI types: it exists to be
        // type-checked, so it has no importer by design.
        "src/api/schema.assert.ts",
      ],
    },

    "packages/db": {
      includeEntryExports: true,
      entry: [
        // Every target of the `exports` map — the workspace consumers
        // (apps/api, apps/cli, the modules) import these subpaths by name.
        ...manifestEntries("packages/db"),
        // Migration CLI, invoked as `bun packages/db/src/migrate.ts`.
        "src/migrate.ts",
      ],
    },

    "packages/mcp-transport": {
      includeEntryExports: true,
      entry: [
        // Sole `exports` target, imported as `@appstrate/mcp-transport`.
        ...manifestEntries("packages/mcp-transport"),
        // Spawned as a subprocess by the transport tests.
        "test/fixtures/echo-server.ts",
      ],
    },

    /**
     * NOT published, despite the `publishConfig` in its manifest — see the
     * `includeEntryExports` note above for the evidence and for what that
     * costs. `includeEntryExports` is therefore UNSET here on purpose and NOT
     * because the published-package exemption applies: turning it on reports
     * 176 findings (79 exports + 97 exported types, 122 distinct names), 159 of
     * them lines in the `src/index.ts` and `src/bundle/index.ts` barrels. Their
     * disposition is one product question — does an unpublished package keep a
     * portable public API — not 159 hygiene calls, so it is deferred to its own
     * pass rather than triaged in a sweep. Measured 2026-08-25; re-measure
     * before acting.
     */
    "packages/afps-runtime": {
      entry: [
        // Every target of the `exports` map plus the manifest `bin` (the
        // `afps` executable, run from a checkout).
        ...manifestEntries("packages/afps-runtime"),
        "examples/**/build.ts",
      ],
    },

    // Modules: the `exports` map is what the module loader resolves when a
    // `MODULES` specifier names the package, and what apps/web imports for
    // the UI surface. Plus the per-module truncate list where the module owns
    // tables — the root test preload skips the file when it is absent, which
    // is why module-chat (no tables of its own) declares none.
    "packages/module-chat": {
      entry: [...manifestEntries("packages/module-chat")],
    },
    "packages/module-claude-code": {
      entry: [...manifestEntries("packages/module-claude-code"), "test/tables.ts"],
    },
    "packages/module-codex": {
      entry: [...manifestEntries("packages/module-codex"), "test/tables.ts"],
    },
    "packages/module-observability": {
      entry: [...manifestEntries("packages/module-observability"), "test/tables.ts"],
    },

    "packages/core": {
      // Every target of the `exports` map. Published on npm and consumed out
      // of tree (cloud, connect-helper, third-party modules), so each subpath
      // is a public entry whose readers this repo cannot see.
      entry: [...manifestEntries("packages/core")],
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
    // declares `exports`, `bin` or `main`, so nothing is derived.
    "runtime-pi": { entry: [...manifestEntries("runtime-pi"), "entrypoint.ts!"] },
    "runtime-pi/sidecar": {
      entry: [...manifestEntries("runtime-pi/sidecar"), "server.ts!", "test/fixtures/**/server.ts"],
    },

    // Every target of the `exports` map. afps-shared is published on npm
    // (core resolves it by range).
    "packages/afps-shared": {
      entry: [...manifestEntries("packages/afps-shared")],
    },
    "packages/connect": {
      includeEntryExports: true,
      entry: [...manifestEntries("packages/connect")],
    },
    "packages/emails": {
      includeEntryExports: true,
      entry: [...manifestEntries("packages/emails")],
    },
    "packages/env": {
      includeEntryExports: true,
      entry: [...manifestEntries("packages/env")],
    },
    "packages/runner-pi": {
      includeEntryExports: true,
      entry: [...manifestEntries("packages/runner-pi")],
    },
    "packages/shared-types": {
      includeEntryExports: true,
      entry: [...manifestEntries("packages/shared-types")],
    },
    "packages/ui": {
      includeEntryExports: true,
      // The `./components/*` wildcard target is deliberately NOT an entry.
      // `packages/ui` is private with exactly one in-repo consumer
      // (`apps/web`), so the published-package carve-out does not apply and
      // "no in-repo reader" *is* evidence of death — but declaring the
      // wildcard as an entry made every design-system component reachable
      // without an importer, so a component nobody renders could never be
      // reported. apps/web imports each component by its own subpath, which
      // puts the live ones in the graph on their own.
      entry: [...manifestEntries("packages/ui", ["./components/*"])],
    },
    // Playwright specs, discovered by the runner, not imported.
    e2e: { entry: [...manifestEntries("e2e"), "**/*.spec.ts"] },
  },
};

export default config;
