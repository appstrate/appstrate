# Changelog

All notable changes to `@appstrate/core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.10.0] — 2026-04-02

### Changed

- **BREAKING**: Rename `flow` to `agent` across all exports:
  - `packageTypeEnum`: `"flow"` value replaced by `"agent"`
  - `PACKAGE_TYPES`: `["flow", ...]` becomes `["agent", ...]`
  - `AFPS_SCHEMA_URLS`: `flow` key replaced by `agent`
  - `flowManifestSchema` renamed to `agentManifestSchema`
  - `FlowManifest` type renamed to `AgentManifest`
- Updated `system-packages`, `zip`, `form`, `schemas` modules for flow-to-agent rename

## [2.9.8] — 2026-03-21

### Added

- `form` export — JSON Schema form utilities (field extraction, UI hints, file field detection)
- `schemas` export — Generated JSON Schema files from Zod definitions

### Changed

- Updated all dependencies to latest compatible versions
- OSS readiness — Apache-2.0 license, SPDX headers, GitHub templates, CI hardening

## [2.9.7] — 2026-03-18

### Changed

- Remove legacy fallbacks, naive checks, and extract helpers into focused modules

## [2.9.6] — 2026-03-15

### Added

- `ssrf` export — SSRF protection utilities (isBlockedHost, isBlockedUrl)
- Strip wrapper folder in `parsePackageZip` for ZIPs created by macOS Finder

### Changed

- Remove unused exports and defensive fallbacks
- Remove `connectionMode` from agent schema
- Remove `x-outputRetries` from agent manifest schema

## [2.8.4] — 2026-02-20

### Changed

- Remove dead exports from semver and version-policy modules
- Remove unused `resolveLatestVersion`, rate-limit module, and AFPS re-exports
- Remove unused `SLUG_REGEX` re-export from validation module

## [2.7.1] — 2026-02-05

### Added

- Migrate package format from `.zip` to `.afps` with `$schema` in manifests
- Flatten execution config to top-level `timeout` + `outputRetries`

### Changed

- Extend `@afps-spec/schema` instead of duplicating Zod definitions
- Generate schemas from AFPS spec URLs instead of Zod

### Fixed

- Rename `outputRetries` to `x-outputRetries` per AFPS §10.1
- Remove arbitrary max(5) cap on `outputRetries`

## [2.7.0] — 2026-02-01

### Changed

- **Breaking**: Merge `requires` → `dependencies`, consolidate modules
- **Breaking**: Rename `extension` package type to `tool` (AFPS v1.0 alignment)

## [2.0.0] — Initial consolidated release

### Added

- Merged `@appstrate/validation` and `@appstrate/packages` into `@appstrate/core`
- 15 exports: logger, env, storage, storage-s3, errors, validation, zip, naming, dependencies, integrity, semver, dist-tags, version-policy, ssrf, system-packages

### Migration

See [Migration from v1](README.md#migration-from-v1) for import path changes.
