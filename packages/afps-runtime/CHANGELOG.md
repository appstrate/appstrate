# Changelog

All notable changes to `@appstrate/afps-runtime` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — `set_checkpoint` tool + scope-aware `add_memory`

- New canonical event `checkpoint.set` (carries `data` + optional
  `scope: "actor" | "shared"`). Emitted by the renamed `set_checkpoint`
  tool — replaces the legacy `set_state` tool.
- `add_memory` tool now accepts an optional `scope` parameter; the
  emitted `memory.added` event carries the field through.
- `RunResult.checkpointScope` records the scope of the most recent
  checkpoint emit so platform finalize logic can route writes into the
  unified `package_persistence` store.
- Platform prompt section renamed `## Previous State` → `## Checkpoint`
  and now documents the scope default (`"actor"`) for both tools.

### Compat — dual-event acceptance for `state.set` ↔ `checkpoint.set`

- The reducer + canonical-event narrower still accept the legacy
  `state.set` event so already-published agents emitting the AFPS ≤ 1.3
  event keep working. Both fold into `RunResult.state` with
  last-write-wins semantics.
- `PLATFORM_TOOLS` keeps the legacy `set_state` entry alongside the new
  `set_checkpoint`. Bundles depending on `@appstrate/set-state@1.0.0`
  resolve unchanged.
- `stateTool` is marked `@deprecated` and emits the legacy `state.set`
  event for end-to-end back-compat. Removal is gated on the floor of
  supported AFPS bundles ≥ 1.4.

### Removed — `afps run` and `afps test` subcommands (BREAKING)

- **`afps run <bundle>` is gone.** Live LLM execution now lives
  exclusively in the `appstrate` CLI (`apps/cli`), which bundles this
  runtime as a workspace dependency and drives the same `PiRunner`
  code path — plus profile / credential-proxy / HMAC sink wiring the
  runtime CLI never had.
  Migration: `appstrate run <bundle> --providers=none --report=false
--model-source=env --model-api=<api> --model=<id> --llm-api-key=<key>
--snapshot <path> --input <json>` matches the previous `afps run`
  surface without requiring an Appstrate instance.
- **`afps test <bundle> --events <path>` is gone.** Scripted-replay of
  user events through `EventSink.handle` + `reduceEvents` is a
  10-line library call; the CLI wrapper added no behaviour. A ready
  snippet ships in the README and in
  `examples/briefing-agent/README.md`.
- The `afps` binary is now strictly bundle tooling: `keygen` / `sign`
  / `verify` / `inspect` / `render` / `conformance`. Removes the only
  command that dynamically imported `@appstrate/runner-pi` and shrinks
  the CLI surface by two commands.

### Changed — earlier in this branch

- **`afps run --events <path>` had already been renamed to
  `afps test --events <path>`.** Both verbs are now removed; the
  rename entry is kept for historical reference.

### Added — Bundle format v1

- Multi-package `Bundle` contract per [`BUNDLE_FORMAT_SPEC.md`](../../docs/architecture/BUNDLE_FORMAT_SPEC.md) §4:
  - Types: `Bundle`, `BundlePackage`, `PackageIdentity`, `BundleMetadata`, `PackageCatalog`, `ResolvedPackage`, `BundleError`, `BUNDLE_FORMAT_VERSION` (`"1.0"`).
  - Integrity chain: per-file hashes in `RECORD` (`sha256=<b64-no-pad>`, PEP 427), per-package SRI digest over the RECORD, bundle-level SRI over the canonical packages map. `metadata` excluded from integrity per spec §4.5.
  - Canonical JSON serializer + deterministic ZIP writer (pinned DOS epoch `mtime`, STORE compression, sorted keys/paths).
  - `readBundleFromFile`/`Buffer`, `writeBundleToFile`/`Buffer` with full §10 conformance (archive sanitization, resource limits, MAJOR-version rejection).
- Catalog utilities:
  - `emptyPackageCatalog` singleton for zero-dep roots.
  - `InMemoryPackageCatalog` (exact + dist-tag + semver range resolution via `semver`).
  - `composeCatalogs(...)` fallback chain (first non-null `resolve` wins; `fetch` routes to the resolving catalog).
- Builders:
  - `buildBundleFromCatalog(root, catalog, opts)` — transitive walk, diamond dedup, cycle tolerance with `onWarn` callback, batched `DEPENDENCY_UNRESOLVED` error.
  - `buildBundleFromAfps(archive, catalog, opts)` — single `.afps → Bundle` conversion primitive used by every ingestion boundary (platform, CLI, GitHub Action).
  - `extractRootFromAfps(archive)` — raw AFPS ZIP → `BundlePackage`.
- `validateBundle(bundle)` — per-package AFPS schema check (agent/skill/tool/provider), cycle detection, divergent-version detection (both SHOULD-level warnings per spec §8).

### Changed — one Bundle path

- **Runtime hot path** speaks `Bundle` end-to-end. `RunOptions.bundle`, resolvers (`ToolResolver` / `SkillResolver` / `ProviderResolver`), `buildProviderExtensionFactories`, `prepareBundleForPi`, `runtime-pi/entrypoint.ts`, and all apps (`apps/api/routes/runs.ts` `buildRunnerBundle`, `apps/cli/commands/run.ts`) migrated from the legacy `LoadedBundle` surface to spec `Bundle`. `providerPrefix` option dropped across Sidecar / Local / Remote resolvers (each provider is its own package now).
- **Three ingestion paths**: `readBundleFromBuffer` (`.afps-bundle`), `buildBundleFromAfps` (`.afps` single-package → Bundle-of-1), `buildBundleFromCatalog` (in-memory). Any other ingestion shape is gone.
- **`canonicalBundleDigest(bundle: Bundle)`** — single signature, takes a `Bundle` directly. **Sig semantics now bind the full Merkle root**: the digest is derived from `Bundle.integrity` (recomputed as if `signature.sig` were absent) and emitted as UTF-8 canonical JSON `{ bundleFormatVersion, root, integrity }`. A tampered byte in ANY file of ANY package invalidates the signature — previously only root-package files were covered. Callers no longer maintain their own root-files flatteners. Breaking: bundles signed by pre-#247 runtimes need to be re-signed. No existing signed bundles in production at `0.0.0`, so no migration action required.
- **CLI commands** (`sign`, `verify`, `inspect`, `render`, `run`) use `readBundleFromBuffer`; `sign` rebuilds the bundle via `writeBundleToBuffer` after injecting `signature.sig`.
- **Signature read** (`readBundleSignature(bundle: Bundle)`) reads `signature.sig` from the root `BundlePackage`.

### Removed — legacy single-package surface

- `LoadedBundle` type, `loadBundleFromBuffer` / `loadBundleFromFile`, `BundleLoadError` (`src/bundle/loader.ts`).
- `bundleToLoadedBundle`, `loadedBundleToBundle`, `loadAnyBundleFromBuffer`, `loadAnyBundleFromFile`, `bundleOfOneFromAfps` migration bridges (`src/bundle/bridge.ts`).
- `validateAfpsManifest` over flat projection (`src/bundle/validator.ts`) — `validateBundle` over spec `Bundle` supersedes it.
- `canonicalBundleDigest(files: Record<string, Uint8Array>, exclude?)` legacy signature — replaced by `canonicalBundleDigest(bundle: Bundle)`.

### Dependencies

- Added `semver ^7.7.1` to support range + dist-tag resolution in catalogs.

## [0.0.0] — 2026-04-20

Initial placeholder release to claim the npm name `@appstrate/afps-runtime`.
No functional code — package skeleton only.

### Added

- Package skeleton (Phase 0 of extraction plan).
- Apache-2.0 license + NOTICE with MIT attributions for the Pi Coding Agent SDK.
- Publish workflow reserved for tag `afps-runtime@X.Y.Z`.
