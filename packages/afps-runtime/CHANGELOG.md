# Changelog

All notable changes to `@appstrate/afps-runtime` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed — five unraised error classes and the `isAfpsError` marker

- `RunTimeoutError`, `RunCancelledError`, `WorkloadExitError`,
  `RunHistoryError` and `CredentialResolutionError` are gone from
  `@appstrate/afps-runtime/errors`, along with their codes (`RUN_TIMEOUT`,
  `RUN_CANCELLED`, `WORKLOAD_EXIT_NONZERO`, `RUN_HISTORY_FETCH_FAILED`,
  `RUN_HISTORY_BAD_RESPONSE`, `CREDENTIAL_RESOLUTION`) in the `AfpsErrorCode`
  union, and the `isAfpsError` marker predicate. Nothing in this package or in
  the platform ever raised one: the taxonomy was written ahead of the call
  sites, and the call sites were built on other error paths. Timeouts,
  cancellation and non-zero workload exits are decided by the runner
  (`PiRunner.readTerminalError`) and surfaced as run status, not thrown as
  typed errors; run-history failures and credential resolution raise
  `ResolverError`. `isAfpsError` existed to branch across the deleted set — the
  two classes that remain, `ResolverError` and `AuthorizedUrisError`, are
  reached by `instanceof` at every live call site.
- `AfpsError` remains exported as the structural shape (`name`, `code`,
  `message`, optional `details`), and `AfpsRuntimeError` remains the base
  class. No live import changes.

### Changed — the two surviving error classes can carry a `cause`

- `AuthorizedUrisError` and `ResolverError` gained an optional trailing
  `options?: ErrorOptions` argument, forwarded to `AfpsRuntimeError`'s base
  constructor. Until now the base accepted `ErrorOptions` and neither concrete
  class passed one, so the parameter was unreachable and the runtime's own
  errors could not participate in a `cause` chain — in the same cycle that
  threaded `cause` through the rest of the platform. Purely additive: every
  existing call site keeps its meaning.

### Removed — four unread re-exports from the resolvers barrel

- `defaultInlineLimit`, `isReproducibleBody`, `resolveBodyForFetch` and
  `serializeFetchResponse` no longer appear in
  `@appstrate/afps-runtime/resolvers`. The three that still have a consumer are
  reached by their own module path from `integration-api-call.ts`;
  `defaultInlineLimit` is now private to `http-call-core.ts`. Barrel-only
  removal — the implementations are unchanged.

### Removed — the `Runner` interface

- `Runner` (`{ name, run(options: RunOptions): Promise<void> }`) is gone from
  `@appstrate/afps-runtime/runner`. It had exactly one implementation and no
  consumer anywhere typed against it — every caller constructs its concrete
  runner directly — so it named a polymorphism nothing exercised, and the
  single-engine decision means no second adapter is coming. `RunOptions`, the
  argument shape a runner is actually handed, stays exported and unchanged: it
  is what a downstream runner conforms to.

### Removed — the `dataschema` attribute

- CloudEvent envelopes no longer carry the OPTIONAL `dataschema` attribute
  (CloudEvents 1.0 §3.1), and `canonicalEventSchemaUri` /
  `CANONICAL_EVENT_SCHEMAS` / `CANONICAL_EVENT_SCHEMA_VERSION` are gone from
  `@appstrate/afps-runtime/events`.

  The URIs it carried were never served — `schemas.afps.dev/v0/events/*` 404s
  and `schemas.appstrate.dev` has no DNS record — but that was the smaller
  problem. AFPS defines `RunEvent` with an OPEN payload: the specification
  reserves event _namespaces_ and deliberately leaves _shapes_ unconstrained,
  "so tools can carry whatever data they need without amending the spec".
  Minting payload schemas under `schemas.afps.dev` asserted a normative shape
  AFPS has not adopted, decided in this repository rather than through the AFPS
  change process. Withdrawing the claim is the honest state.

  Standardizing event payloads remains possible — as a spec change first
  (§events in `spec.md`, documents under `packages/schema/v0/events/`, a Pages
  job that copies them), and only then an attribute here.

  **Receivers reject `dataschema` on the wire.** The platform's ingestion
  envelope is `.strict()` and declares no such member, so an envelope carrying
  it 400s. That is safe because the platform / `PI_IMAGE` / `SIDECAR_IMAGE`
  trio is version-locked at boot (#1201): a pre-removal image cannot reach a
  post-removal receiver.

### Changed

- The canonical payload contract is now data: `CANONICAL_CONSTRAINTS` is a
  table of `{ path, holds }` entries that `isCanonicalRunEvent` iterates,
  replacing a hand-written `switch`. Behaviour is unchanged — the 60-fixture
  corpus pins every verdict — but the set of constrained field paths is
  recoverable again without parsing TypeScript.

  That set is what a coverage guard needs. `test/types/canonical-events.test.ts`
  derives it and asserts that each constraint is, for some fixture, the one
  that rejects it; a constraint added without a fixture violating it now fails
  by name. The previous guard derived the same set from generated JSON Schema
  documents and was lost when those were removed as unpublished (issue #1184).

- New export `firstViolatedConstraint(event)` — the path of the first
  constraint an event violates, or `undefined`. It backs the coverage guard and
  makes rejection reasons legible to callers.

### Removed — unused surface

- `composeCatalogs(...)` (`@appstrate/afps-runtime/bundle`). No production caller
  ever appeared: it was written for inline runs, but the platform's
  `RunPackageCatalog` needs owner tracking and a loud throw on a missed draft
  override, semantics a silent first-non-null fallback chain cannot express.
  `InMemoryPackageCatalog` stays — it is the reference `PackageCatalog`
  implementation, though its doc no longer claims to back inline runs.
- `writeBundleToFile(bundle, path)` (`@appstrate/afps-runtime/bundle`). Two
  lines over `writeBundleToBuffer`, with no caller outside a test; the platform
  writes bundle bytes to object storage, not to disk. Callers that want a file
  own the `writeFile`.
- `src/types/manifest.ts`, a pass-through re-export of `@afps-spec/schema` that
  existed so consumers would not need a direct dependency on the spec package.
  No consumer ever took it — every one, including this package, imports
  `@afps-spec/schema` directly.
- `apiCallToolName` left the `resolvers` barrel and `slugifyIntegrationId` is
  now module-private; neither had a consumer outside this package.

### Changed — the text/binary media-type set is no longer mirrored

- `http-call-core.ts` classified response bodies against a hand-copy of the
  media-type set in `@appstrate/core/mime`, guarded by a parity test. The set
  moved to `@appstrate/afps-shared/mime` (a `workspace:*` dependency here, and
  the dependency core itself re-exports verbatim), so both layers now read one
  definition and the parity test is gone with the copy. `isTextLikeMimeType`
  keeps its one documented deviation — an explicit `charset` parameter counts
  as a declaration of textness — and behaves identically otherwise.

### Added — `dataschema` URIs for canonical CloudEvent payloads

- New `@appstrate/afps-runtime/events` exports (`CANONICAL_EVENT_SCHEMAS`,
  `CANONICAL_EVENT_SCHEMA_VERSION`, `canonicalEventSchemaUri`): the seven
  canonical event `data` payloads (`memory.added`, `pinned.set`,
  `output.emitted`, `log.written`, `appstrate.progress`, `appstrate.error`,
  `appstrate.metric`) each have a stable, versioned schema URI.
- `buildCloudEventEnvelope` stamps the OPTIONAL CloudEvents `dataschema`
  attribute with the matching URI. Additive and non-breaking: no existing
  attribute changes, and the attribute is omitted for third-party
  (`@scope/tool.verb`) events and for canonical types whose payload does not
  actually satisfy the shape (`isCanonicalRunEvent` gates it).
- The URIs are identifiers, not documents — nothing serves them.
  `schemas.afps.dev/v0/events/*` 404s (the afps-spec Pages job publishes
  `packages/schema/v0/*.schema.json` flat, with no `events/` directory) and
  `schemas.appstrate.dev` was never stood up. This is conformant: CloudEvents
  1.0 §3.1 does not require `dataschema` to dereference.
- A Zod payload table, a JSON Schema 2020-12 generator
  (`buildCanonicalEventJsonSchema(s)`, `serializeCanonicalEventJsonSchema`),
  seven committed artifacts under `schemas/v0/events/` and a `schemas:generate`
  script existed here and were removed before release: they produced documents
  for the unserved URIs above, `schemas:generate` ran in no workflow, and the
  drift tests guarded a shape nobody could fetch. `isCanonicalRunEvent`
  (`src/types/canonical-events.ts`) is the payload contract. Rebuild the
  generator only together with the publication step.

### Removed — RFC 9457 problem+json layer

- `toProblem()`, `ProblemDetails`, `afpsErrorTypeUri()`, `AFPS_ERROR_CODES` and
  the `https://docs.appstrate.dev/errors/afps/{code}` URI namespace are gone
  from `@appstrate/afps-runtime/errors`. They were added and removed within the
  same unreleased cycle: no wire ever carried them. The platform serialises
  errors through `@appstrate/core/api-errors` plus
  `run-launcher/bundle-error-mapping.ts`, which translates this taxonomy into
  the platform's own catalogue. `ResolverError` and `AuthorizedUrisError` are
  unaffected; `WorkloadExitError` and `isAfpsError` were removed later in the
  same unreleased cycle (see "Removed — five unraised error classes and the
  `isAfpsError` marker" above). Build an HTTP envelope from `code` + `message`
  on the two surviving classes.

### Added — shared tool-result truncation

- `@appstrate/afps-runtime/runner` now exports `truncateToolResult` and
  `toolResultByteLimit` — byte-aware, UTF-8-safe truncation of tool-result
  payloads before they ride an `EventSink` (env-tunable via
  `TOOL_RESULT_BYTE_LIMIT`). Shared by every Runner that forwards tool results;
  previously duplicated inside the Pi runner.

### Added — Letta-style `note` + `pin` tools

- New `noteTool` (`note`) and `pinTool` (`pin`) replace `memoryTool`
  (`add_memory`) and `checkpointTool` (`set_checkpoint`). `pin` accepts
  a required `key` parameter — `key="checkpoint"` is the legacy
  carry-over slot, other keys (e.g. `"persona"`, `"goals"`) are
  first-class named pinned blocks.
- New canonical event `pinned.set` (carries `key` + `content` + optional
  `scope`). Replaces `checkpoint.set`. The reducer aggregates events
  into `RunResult.pinned: Record<string, PinnedSlot>`; the
  `key="checkpoint"` slot is mirrored into the legacy top-level
  `RunResult.checkpoint` field for backward compatibility.
- `PLATFORM_TOOLS` now keys on `note` / `pin` (and `output` / `report` /
  `log`).
- Platform prompt's memory section references `note({ content })` and
  `pin({ key, content })`. The `## Checkpoint` section instructs agents
  to update via `pin({ key: "checkpoint", content })`.

### Removed — two exports with no consumer (BREAKING)

- `narrowCanonicalEvent` (`@appstrate/afps-runtime/types`) — a one-line
  `isCanonicalRunEvent(e) ? e : null` wrapper whose only remaining caller was
  the reducer's `foldEvent`, which now calls the guard directly. The guard
  already declares `event is CanonicalRunEvent`, so switch exhaustiveness is
  unchanged; callers replace `narrowCanonicalEvent(e) !== null` with
  `isCanonicalRunEvent(e)`.
- `SkillRef` re-export (`@appstrate/afps-runtime/resolvers`, and the internal
  `resolvers/types.ts`) — its three usages lived in the deleted
  `bundled-skill-resolver.ts`. Import it from `@afps-spec/types` directly.

### Removed — `add_memory` / `set_checkpoint` tools (BREAKING)

- `memoryTool` / `add_memory` and `checkpointTool` / `set_checkpoint`
  are removed from `PLATFORM_TOOLS`. Agents that imported the system
  packages `@appstrate/add-memory` / `@appstrate/set-checkpoint` must
  switch to `@appstrate/note` / `@appstrate/pin`.
- `checkpoint.set` event type removed. Runners that emitted it must
  emit `pinned.set` with `key: "checkpoint"`.
- Compat aliases were intentionally not added; an earlier breaking change
  already required redeploys.

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

### Removed — `set_state` tool + `state.set` event (BREAKING)

- `stateTool` / `set_state` removed from `PLATFORM_TOOLS`. Agents that
  emitted `state.set` must rebuild against `set_checkpoint`.
- `StateSetEvent` removed from the canonical-event union; the reducer +
  narrower no longer fold it. `RunResult.state` renamed to
  `RunResult.checkpoint`.
- Bundles depending on `@appstrate/set-state@1.0.0` no longer resolve;
  depend on `@appstrate/set-checkpoint@2.0.0` instead.

### Removed — `afps run` and `afps test` subcommands (BREAKING)

- **`afps run <bundle>` is gone.** Live LLM execution now lives
  exclusively in the `appstrate` CLI (`apps/cli`), which bundles this
  runtime as a workspace dependency and drives the same `PiRunner`
  code path — plus profile / credential-proxy / HMAC sink wiring the
  runtime CLI never had.
  Migration: `appstrate run <bundle> --integrations=none --report=false
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
