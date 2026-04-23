# Changelog

All notable changes to `@appstrate/afps-runtime` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — CLI verbs

- **`afps run --events <path>` renamed to `afps test --events <path>`.** The
  scripted replay validates the sink + reducer contract — a conformance test,
  not an agent execution. The `test` verb reflects that.

### Added — `afps run` live execution

- **`afps run <bundle> --api <api> --model <id>`** executes a bundle against a
  real LLM via `@appstrate/runner-pi` (Pi Coding Agent SDK), in-process, with
  no Docker and no sidecar. Provider-authenticated tools are NOT supported —
  the Appstrate platform is the right place for those.
- `@appstrate/runner-pi` is dynamic-imported so the base `afps-runtime`
  package remains hermetically free of Pi SDK types and code. Missing
  `runner-pi` or missing `@mariozechner/pi-coding-agent` peer dep each surface
  a dedicated install hint.
- Supports `--api-key` / `$AFPS_API_KEY`, `--base-url`, `--context`
  (inline JSON object, defaults to `{}`), `--snapshot` (file path),
  `--trust-root` (enforces signature verification),
  `--timeout`, `--thinking-level`, `--workspace` (auto-tempdir with cleanup),
  `--sink console|file|both|none`, `--sink-file`, `--output` (JSON RunResult
  dump). Exit codes: 0 success, 1 runtime, 2 usage, 3 bundle/signature,
  4 timeout, 130 SIGINT. API key is redacted from every surfaced error.
- Exported helpers: `createRunHandler(deps)` for DI-based testing and
  `assembleExecutionContext(contextFile, snapshot)` for direct unit tests.

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
