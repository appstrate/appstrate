# Changelog

All notable changes to `@appstrate/core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Collapses the multi-engine execution model onto the single Pi engine
(`@mariozechner/pi-coding-agent`). API-key and OAuth subscription runs (Claude
Pro/Max, ChatGPT Codex) all execute on Pi, whose SDK (`@mariozechner/pi-ai`)
emits each provider's subscription request fingerprint natively — the platform
forges nothing. Removes the provider→execution-engine binding contract in favour
of a provider-neutral bearer-swap.

### Added

- **`@appstrate/core/oauth-bearer-swap`** — `applyOauthBearerSwap(headers,
accessToken)`, the sidecar `/llm` oauth branch's only header policy. Forces the
  real subscription bearer onto `authorization`, drops any `x-api-key`, and
  forwards every other header verbatim. Provider-neutral — it touches no
  provider-specific header, so the Pi SDK's own request fingerprint (user-agent,
  `anthropic-beta`, `chatgpt-account-id`, …) rides through unchanged. Pure (no
  credential lookup, no I/O); the caller owns SSRF + credential resolution.

### Removed (BREAKING)

- **`@appstrate/core/subscription-engines` removed.** The provider→execution-engine
  binding registry (the `"claude"|"codex"` engine vocabulary, the binding shape,
  and the read/write accessors, added in 3.0.0) is gone. There is a single Pi
  execution engine; runs are no longer routed by a per-provider engine binding.
- **`@appstrate/core/claude-oauth-gateway` removed.** The anthropic-specific OAuth
  gateway header helper (`applyClaudeOauthGatewayHeaders`, which forced the
  bearer and ensured `anthropic-beta: oauth-2025-04-20`) is superseded by the
  provider-neutral `@appstrate/core/oauth-bearer-swap`.
- **`ModelProviderHooks.beforeLlmProxyRequest` removed** (with the
  `ModelProviderProxyContext` / `ModelProviderProxyPatch` types from
  `@appstrate/core/module`). The per-request header-patch hook had no platform
  caller once the forging wire-format path was deleted — the sidecar's only
  oauth header policy is the provider-neutral bearer-swap, and any
  provider-specific routing header (e.g. `chatgpt-account-id`) is emitted by
  Pi's SDK from the token itself.
- **`LlmProxyOauthConfig.modelSwap` removed** (`@appstrate/core/sidecar-types`).
  The oauth sidecar mode is a pure bearer-swap and never rewrites the
  request/response body; model aliases are rejected for oauth-subscription
  providers instead. `checkAliasInvariants` (`@appstrate/core/model-swap`) now
  requires an `authMode` input and returns the new `"oauth_provider"`
  violation for an alias backed by an oauth credential. `modelSwap` remains on
  `LlmProxyApiKeyConfig` (api_key aliases are unchanged).

  These are removed public API → requires a major version bump on next
  publish. Consumers on the `claude`/`codex` engine vocabulary should drop it;
  the run path is provider-neutral.

## [3.0.0] — 2026-07-08

Major release: removes forging OAuth subscription wire-format, the deprecated
`ContainerOrchestrator` alias, and the dead `RealtimeEvent` envelope (all
BREAKING). Adds the orchestrator/subscription-engine module extension points,
proxy-upload storage mode, and the shared model-alias swap. `ssrf` DNS layer
now lives in `@appstrate/afps-shared` ^0.2.0.

### Added

- **`@appstrate/core/storage-s3`** — proxy-upload mode (issue #829).
  `S3StorageConfig` gains optional `uploadBaseUrl` + `uploadSecret`: when set
  and no `publicEndpoint` is configured, `createUploadUrl()` returns an
  HMAC-signed app-domain URL (`PUT /api/uploads/_content`) instead of a
  presigned direct-to-bucket URL, so the blob store (e.g. a compose-internal
  MinIO) never needs to be publicly reachable. Setting `publicEndpoint`
  opts back into direct presign. Existing configs are unaffected.
- **`@appstrate/core/storage-fs`** — exports `createProxyUploadDescriptor` +
  `ProxyUploadUrlConfig`, the shared app-domain signed-URL builder now used
  by both the filesystem backend and the S3 backend's proxy mode.

### Fixed

- **`@appstrate/core/storage-s3`** — `uploadStream()` now explicitly aborts
  the S3 multipart upload when it fails AFTER the parts were uploaded.
  `@aws-sdk/lib-storage` cleans up after part-upload failures but not when
  the final `CompleteMultipartUpload` fails — which is exactly the
  `If-None-Match` 412 path taken by a concurrent or replayed
  `exclusive: true` PUT (> 5 MiB). Without the abort, every such failure
  stranded an incomplete multipart upload: MinIO expires those after ~24 h,
  but AWS S3 / R2 retain (and bill) the parts indefinitely unless the bucket
  has an `AbortIncompleteMultipartUpload` lifecycle rule.
- **`@appstrate/core/run-and-wait-client`** — `kind:"inline"` now rejects a
  missing top-level `prompt` before dispatching, with an actionable message.
  When the prompt is found nested inside `manifest` (the common LLM mistake —
  AFPS agents ship a `prompt.md`, so models naturally put it there), the error
  says to move it to the top level instead of forwarding a promptless body to
  `POST /api/runs/inline` and surfacing the route's bare
  `prompt: must be a string`.

### Added

- **`@appstrate/core/module`** — new optional extension point
  `AppstrateModule.orchestrators?(): Record<string, OrchestratorRegistration>`.
  Modules can contribute execution backends (run orchestrators) keyed by
  `RUN_ADAPTER` value; a duplicate id across modules/core is a fatal boot
  error. The registration type (`isolatesWorkloads`, `supportsSidecarOnly`,
  `create`) lives in `@appstrate/core/platform-types` next to
  `RunOrchestrator`.
- **`@appstrate/core/subscription-engines`** — the provider→execution-engine
  binding registry contract: the `"claude"|"codex"` engine vocabulary, the
  binding shape (credential-delivery mode, egress allowlist, native-output
  capability, chat handler), and the read/write accessors. Ships zero bindings —
  the `claude` / `codex` bindings are contributed at boot by their opt-in
  provider modules.
- **`@appstrate/core/subprocess-env`** — `buildIsolatedSubprocessEnv()`, a
  curated, no-secret-leak environment for spawned subprocesses.
- **`@appstrate/core/runtime-event-drain`** — runtime-tool event drain helpers
  that relay sidecar runtime-tool events into the run-event pipeline.
- **`@appstrate/core/sidecar-types`** — `LlmProxyOauthConfig`
  (`authMode: "oauth"`) is now the single, **non-forging** OAuth `/llm` mode: the
  sidecar swaps the bearer + ensures the OAuth beta only, leaving the driver's own
  fingerprint untouched (the official Claude Agent SDK binary signs its own). The
  `LlmProxyConfig` union is `LlmProxyApiKeyConfig | LlmProxyOauthConfig`.

### Removed — OAuth subscription fingerprint forging (BREAKING)

- **`OAuthWireFormat` interface + `OAuthAdaptiveRetryPolicy` removed** from
  `@appstrate/core/sidecar-types`, and **`ModelProviderDefinition.oauthWireFormat`
  removed** from `@appstrate/core/module`. Provider modules no longer declare
  identity headers / system-prepend / body coercions / adaptive retries.
- The previous (forging) `LlmProxyOauthConfig` and the transitional
  `LlmProxyOauthPassthroughConfig` are gone — folded into the single non-forging
  `LlmProxyOauthConfig` above.

- **`@appstrate/core/model-swap`** — the model-alias swap (LLM-gateway alias
  pattern, appstrate#727). Exports `swapRequestModel`, `swapResponseModelJson`,
  `createSseModelSwapStream`, `scrubModelText`, `isAliasableApiShape`, and
  `ALIASABLE_API_SHAPES`. Single source of truth shared by both inference data
  paths — the in-container sidecar proxy and the platform LLM gateway — so a
  public alias id is rewritten to/from its real backing id at exactly one
  implementation. The `ModelSwap` interface remains in
  `@appstrate/core/sidecar-types`.

### Removed

- **BREAKING: `ContainerOrchestrator` removed from `@appstrate/core/platform-types`.**
  Deprecated alias of `RunOrchestrator` (the pre-rename name, kept "for npm
  consumers") with zero remaining consumers — import `RunOrchestrator` instead.
- **BREAKING: `RealtimeEvent` removed from `@appstrate/core/platform-types`.**
  The loose `{ event: string; data: Record<string, unknown> }` envelope was
  dead — the platform's SSE pipeline uses the typed discriminated union in
  `@appstrate/shared-types` (`realtime-events`). External consumers that
  imported it should define their own equivalent or adopt the typed union.
  Requires a major version bump on next publish.

### Changed

- **`dist-tags` `isProtectedTag` now also protects `draft` and `published`**
  (appstrate#670) — previously only `latest`. These are reserved
  `version_ref` selector keywords; allowing same-named dist-tags would let a
  tag shadow the selector. Consumers that create/delete dist-tags must treat
  all three names as reserved.
- **`ssrf` DNS layer moved to `@appstrate/afps-shared/ssrf-dns`** —
  `@appstrate/core/ssrf` re-exports `resolveAndCheckHost`/`HostResolver`/
  `ResolvedHostCheck` verbatim (import paths unchanged); the implementation
  now lives in the leaf package so `@appstrate/afps-runtime` (standalone
  `afps` CLI) shares the exact same rebind protection. Requires
  `@appstrate/afps-shared` ^0.2.0. The `defaultHostResolver` export was
  dropped from `@appstrate/core/ssrf` (never consumed; inject via the
  `deps.resolve` parameter instead).

### Fixed

- **`storage-s3` presigned upload URLs no longer bind a placeholder CRC32
  checksum** (appstrate#630). AWS SDK ≥3.729 defaults
  `requestChecksumCalculation` to `WHEN_SUPPORTED`, signing
  `x-amz-checksum-crc32=AAAAAA==` (CRC32 of the empty presign body) into
  `createUploadUrl`'s query string — S3 then rejected every plain PUT unless
  the client sent the real base64 CRC32 as a header. The presign client now
  uses `WHEN_REQUIRED`, so the returned descriptor's `headers` are the
  complete client contract. Server-side uploads keep the SDK's default
  checksum behaviour.

## [2.26.0] — 2026-06-07

Canonical packageId path encoding. Additive — no removals, no breaking changes.

### Added

- **`encodePackageIdPath(packageId)`** (`@appstrate/core/naming`) — encodes an
  `"@scope/name"` packageId into a URL path segment, keeping the `@`/`/`
  separators literal so it matches both route shapes (`/:scope{@…}/:name` and
  `/:packageId{@…/…}`). Replaces hand-rolled `encodeURIComponent(packageId)`,
  which percent-encodes `@`→`%40` and `/`→`%2F` and 404s every scoped route.
  The one contract all consumers (frontend, SDK, github-action, MCP) should
  import. Throws on invalid packageId.

## [2.25.0] — 2026-06-07

Storage streaming + integration spawn/egress contract additions. All additive — no removals, no breaking changes.

### Added

- **`Storage.uploadStream(bucket, path, stream, opts?)`** — pipe binary data to a
  backend without buffering the whole payload in memory (S3 multipart via
  `@aws-sdk/lib-storage`; filesystem pipes the web stream straight to disk).
  `opts.exclusive` is unsupported on this path and throws. Implemented in both
  `storage-s3` and `storage-fs` backends.
- **`IntegrationSpawnSpec.mcpServer.version`** — the concrete published version
  the run resolved at kickoff, forwarded to the mcp-server-bundle byte route so
  runnable bytes match the manifest version (eliminates manifest/bytes skew,
  issue #588). Omitted for system mcp-servers and remote/serverless integrations.
- **`IntegrationSpawnSpec.needsEgress`** — explicit egress signal for a
  local-source runner that needs a controlled outbound route but no header
  injection (e.g. a `delivery.env` integration that authenticates itself); the
  sidecar mounts a plain CONNECT egress listener (issue #543).

### Changed

- **`connectableAuthKeysForAgent`** — an integration exposing `api_call` is now
  its own selection signal: it returns the declared auth keys even when the agent
  picked zero tools and zero scopes, since `api_call` is consumed with an explicit
  `auth_key` pin and still needs a connection. Returns `[]` only when there are no
  tools, no scopes, AND no `api_call` configs.

## [2.24.0] — 2026-06-05

Module-contract cleanup + table-centralization (PR #586, supersedes #577/#583).

> **BREAKING (type surface).** Members were removed from the published
> `@appstrate/core/module` and `@appstrate/core/platform-types` subpaths. No
> in-tree or first-party consumer references the removed members (the only
> `PlatformServices` consumer, `@appstrate/cloud`, reads solely
> `runs.listLlmUsage`, which is retained), so the practical blast radius is
> zero — hence a minor bump rather than a major. An external module that
> implemented any removed member under `satisfies`/excess-property checks would
> need to drop it.

### Removed

- **`AppstrateModule` contract** — dead members with no real consumer:
  `appScopedPaths`, `api` (+ `OidcModuleApi`), `oidcScopes`, `drizzleSchemas`.
- **`ModuleInitContext`** — `applyMigrations`, `databaseUrl`, `isEmbeddedDb`
  (modules own no tables; a separate-tenant module runs its own DB/migrations).
- **`PlatformServices`** trimmed to `{ logger, runs: { listLlmUsage } }` —
  removed the speculative chat-era surface (`orchestrator`, `pubsub`, `env`,
  `models`, `packages`, `applications`, `inline`, `realtime`, `modules`, and
  `runs` CRUD/`abort`), plus the now-orphaned `RunUpdate` / `RunLogLevel` types.
- **`@appstrate/core/platform-types`** — types that only shaped the removed
  `PlatformServices` members: `PlatformPackage`, `PlatformPackageDependency`,
  `PlatformModel`, `PlatformApplication`, `RealtimeSubscriber`,
  `RealtimeSubscriberFilter`, `InlinePreflightInput`, `InlinePreflightResult`,
  `InlinePreflightMode`.

### Added

- **`PlatformServices.runs.listLlmUsage`** — billing-free read into the platform
  `llm_usage` ledger (`{ id, costUsd, source }[]`), letting a metering module
  reconcile per-call usage without a cross-module SQL join.

## [2.20.0] — 2026-05-16

### Added

- `@appstrate/core/sidecar-types` — `TokenBudget` gains
  `contextWindowTokens` + `reserveTokens` fields, enabling a pre-flight
  context-window guard for parallel tool-call outputs. A
  `provider_call` output that would push `consumed + estimated` past
  `contextWindow − reserve` now spills with reason
  `exceeds_context_window`, even when it fits under the per-call inline
  cap and the run-budget ceiling. Fixes a class of parallel-fan-out
  failures where a batch of individually-safe outputs blew past the
  model's context window before turn-boundary auto-compaction could
  fire (e.g. Claude Haiku 4.5 + Gmail parallel fetch).

- `@appstrate/core/sidecar-types` — `RuntimeReady` event surface
  formalised for the platform's `runtime-ready` event-pipeline
  contract, alongside the parallel agent/sidecar boot reorganisation
  in `runtime-pi`. No new top-level export — the contract lives on the
  existing `sidecar-types` surface that runtime-pi consumes.

### Changed

- `@appstrate/core/module` + `@appstrate/core/platform-types` — minor
  shape refinements around the `pricing catalog` + `providerId`
  hardening landed in #439 (Portkey migration epic, net −1860 LoC).
  Module init context types align with the new pricing-catalog read
  path. No public API renames; existing module authors are unaffected
  unless they used the previously-internal `apiShape`/`baseUrl` model
  fields, which were dropped in the same PR (see migration `0022`).

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
