# Changelog

All notable changes to `@appstrate/core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.18.0] — 2026-04-27

### Changed

- `@appstrate/core/env::createEnvGetter` now coalesces empty-string env
  values to `undefined` before Zod validation runs. Aligns the helper
  with Docker Compose's `${VAR:-}` pattern (an unset host variable is
  forwarded to the container as a literal `VAR=`, not as a missing
  key) so Zod's `.default(...)` fires uniformly across every refined
  field. Previously, `MY_VAR=` would fail boot for any field with a
  refine guard or enum, with a cryptic `must be …` error.

  Subtle observable change for `.optional()` fields: `MY_VAR=` now
  parses to `undefined` instead of `""`. Safe for env vars in
  practice (the host shell never assigns a meaningful empty string),
  but downstream code that distinguished `""` from `undefined` would
  need to be updated.

## [2.12.0] — 2026-04-19

### Added

- `@appstrate/core/api-errors` — HTTP error layer (`ApiError`, factory
  helpers `invalidRequest` / `unauthorized` / `forbidden` / `notFound` /
  `conflict` / `gone` / `internalError` / `systemEntityForbidden`,
  `parseBody`, `asRecord`). Lets external modules loaded via `MODULES=`
  build RFC 9457 `problem+json` responses without reaching into
  `apps/api/src/*`.
- `@appstrate/core/platform-types` — structural contracts for platform
  capabilities (`ContainerOrchestrator`, `PubSub`, workload types).
- `ModuleInitContext.services` — typed `PlatformServices` surface
  (orchestrator, pubsub, models, packages, runs, realtime, cross-module
  events, logger) wired by the platform at module init. External modules
  now depend only on `@appstrate/core` at compile time and receive every
  runtime capability through the init context.

### Changed

- Internal: `safe-json` helper exported for module use.

## [2.11.1] — 2026-04-18

### Changed

- `validateManifest(raw)` — when the input has no `type` field, validation
  now falls through to the base `manifestSchema` and returns every
  missing/invalid field Zod reports, instead of short-circuiting on a
  single `"type: Required field is missing"` string. Consumers that
  aggregate `result.errors` (e.g. joining with `"; "`) are unaffected.
  Consumers that asserted on the exact single-string output must update
  their expectations.

## [2.10.8] — 2026-04-15

### Added

- `form` export — AFPS `SchemaWrapper` to RJSF mapper (`mapAfpsToRjsf`), file-field detection helpers (`isFileField`, `isMultipleFileField`), `asJSONSchemaObject` cast helper. Used by the new `@appstrate/ui/schema-form` package.
- `storage-s3`: support `S3_PUBLIC_ENDPOINT` for presigned URLs served behind a public domain distinct from the internal S3 endpoint.

### Changed

- Internal cleanup of `validation.ts` / `storage.ts` test surface.

## [2.10.7] — 2026-04-11

### Changed

- Bump `@afps-spec/schema` to `^1.3.1` — adds `tokenAuthMethod` and `tokenContentType` fields to the provider OAuth2 config schema.
- Refresh `schema/provider.schema.json` with the new OAuth2 token handling fields.

## [2.10.6] — 2026-04-11

### Added

- `module` export — `AppstrateModule` contract, `ModuleManifest`, `ModuleInitContext`, hook & event type maps. Enables external modules to implement the Appstrate module system without depending on the API package.

### Changed

- Updated `Run` schema with enrichment fields (`dashboardUserName`, `endUserName`, `apiKeyName`, `scheduleName`).

## [2.10.3] — 2026-04-02

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
