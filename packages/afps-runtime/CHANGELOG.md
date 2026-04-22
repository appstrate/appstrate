# Changelog

All notable changes to `@appstrate/afps-runtime` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Bundle format v1 (Phase 1)

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
- New validator: `validateBundleV2(bundle)` — per-package AFPS schema check (agent/skill/tool/provider), cycle detection, divergent-version detection (both SHOULD-level warnings per spec §8).
- Bridge helpers for migration: `loadedBundleToBundle`, `bundleOfOneFromAfps`.

### Kept for migration

The legacy single-package surface (`LoadedBundle`, `loadBundleFromBuffer`/`File`, `BundleLoadError`, original `validateBundle`) is **retained** during Phase 1. The runner-pi container, AFPS resolvers, and platform container runner still consume it. Each consumer migrates to the new `Bundle` API in its own PR; the legacy symbols will be removed in a follow-up once all callers have moved.

### Dependencies

- Added `semver ^7.7.1` to support range + dist-tag resolution in catalogs.

## [0.0.0] — 2026-04-20

Initial placeholder release to claim the npm name `@appstrate/afps-runtime`.
No functional code — package skeleton only.

### Added

- Package skeleton (Phase 0 of extraction plan).
- Apache-2.0 license + NOTICE with MIT attributions for the Pi Coding Agent SDK.
- Publish workflow reserved for tag `afps-runtime@X.Y.Z`.
