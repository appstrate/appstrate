# Changelog

All notable changes to `@appstrate/core` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Breaking, batched per the release policy in `.github/workflows/publish-core.yml`:
these changes accumulate here until a deliberate major. `7.0.0` is already
published without them, so the version in `package.json` does not move.

**Out-of-tree consumers.** The config removals below touch nothing `cloud` or
`connect-helper` import. The `document` → `file` rename (#1177) does: both
consume `module`, `api-errors`, `telemetry` and `permissions`, and the rename
lands on all four — the symbols a consumer imports today are
`PlatformServices.cleanupSessionDocuments` / `setDocumentStorageLimit`,
`documentCountExceeded`, `recordDocument*` and `CoreResources.documents`.

Staying pinned to the published `7.0.0` protects them at the TYPE level only.
`cloud` also binds one of these off the LIVE services object the platform
injects at runtime — `services.setDocumentStorageLimit.bind(services)`
(`cloud/src/billing/storage-entitlement.ts`) — and a compile-time pin does
nothing for a property read at boot.

That seam was held open for a while by a deprecated `setDocumentStorageLimit`
alias declared beside the canonical `setFileStorageLimit`. **The alias is now
gone**, and the two repos move in lockstep instead: `cloud` binds
`setFileStorageLimit` and declares `@appstrate/core` `>=8.0.0`. That range is
not cosmetic — the published `7.0.0` exposes ONLY the old name, so a cloud
build resolving `7.0.0` would typecheck against a services object without the
member it now reads. Local dev resolves core through a workspace symlink and
would not have caught it.

**Ship order is therefore fixed**: core `8.0.0` on npm → `cloud` → the platform
build. Deploying the platform first `TypeError`s cloud at boot.

`cleanupSessionDocuments` → `cleanupSessionFiles` never had such an alias. Its
only consumer is the in-tree `@appstrate/module-chat`, which ships in the same
image and was renamed in the same commit, so an alias would have needed a
ledger owner in `scripts/verify-module-contract.ts` that does not exist — a
fiction rather than a contract. An out-of-tree module binding the old name off
the live services object WILL break; that is the accepted cost, recorded here
rather than left as an oversight. The same now goes for the storage-limit
capability.

`connect-helper` reads none of this surface and is unaffected either way.

The eventual major release of this branch still requires a matching code change
in `cloud`, not just a version bump.

An AFPS agent manifest used to declare TWO parameter schemas — `input` (asked
per run) and `config` (set once at setup). AFPS 0.3 removed `config`; whether a
value is asked every time or stored once is a deployment policy, not a property
of the package. Core no longer reads `manifest.config` at all.

`document` is a false friend: the entity is any file an agent produced —
Markdown, HTML, source code, a PDF, an image — but the word promises a Word or
PDF document to every reader, the model included. The concept is renamed to
`file` throughout (#1177).

The rename first landed here with a read alias on every wire-visible and
persisted spelling. **Those aliases are gone**, and they never reached npm: they
were added and removed inside this same unreleased window, so relative to the
published `7.0.0` they are not a deprecation, they simply never existed. What
went with them is listed under Removed — the legacy permission-resource table,
the retired runtime-tool event type, and the `document://` URI prefix.

**No read alias survives this release.** The two that were argued for on the
grounds that a RELEASED build had written values a current build still reads —
the `"document"` tag in `PUBLISHED_FILE_LOG_EVENTS` (a `run_logs` row is
immutable once written) and the `publish_document` runtime-tool id on a
persisted manifest (a published package version is immutable) — are gone too:
no such row and no such manifest exists. A deployment that held one would see
that single log row render without its attachment, and that one tool id
dropped from the manifest with the drop reported — never a silent
reinterpretation. The platform-side environment variables moved too, with no alias
(`FILE_MAX_BYTES`, `RUN_MAX_FILES`, `FILE_RETENTION_DAYS`,
`WORKSPACE_MAX_FILES_BYTES`) — see the platform CHANGELOG; core reads none of
them, it only names them in docblocks.

### Added

- **`authorDefaults(schema)`** (`./form`) — the top-level properties of a JSON
  Schema that declare a `default`, as a plain value map. This is the author
  layer of input resolution, published so the platform and the CLI compute it
  identically: the same bundle must yield the same parameters whether the run
  is launched locally or on a platform. A property with no `default` stays
  ABSENT rather than becoming `null`, so a lower layer — or the schema's own
  `required` check — sees the truth.
- **`validateAgainstSchema` / `SchemaValidationResult`** (`./schema-validation`)
  — `validateConfig` / `ConfigValidationResult` under a name that describes
  what they do. Same signature, same verdict.
- **`./file-uri`** — the URI helpers, renamed from `./document-uri`.
  `appfile://<id>` is the only spelling written AND the only one read.
  Deliberately NOT `file://` — that scheme already means the local filesystem
  and MCP uses it for local resources, so an opaque platform id under it is
  ambiguous to the model and to every MCP client. Exports `FILE_URI_PREFIX`,
  `FILE_ID_RE`, `isFileUri`, `parseFileUri`, `fileUri`, `extractFileIds`,
  `extractFileIdsFromText` (plus the unchanged `upload://` helpers).
  `FILE_ID_RE` matches the `file_` row-id prefix — it was `doc_` until the
  rename reached the physical layer, and the old shape is no longer accepted,
  which is what made the `document://` prefix unreachable (see Removed).
- **`PUBLISHED_FILE_LOG_EVENTS`** (`./file-uri`) — every `run_logs.event` tag
  that announces a published file, canonical first: `["file", "document"]`. It
  lives beside `FILE_URI_PREFIX` because it is the same kind of
  thing — pure data about a wire spelling that two independent readers (the web
  shell's run page and the chat module's run card) must agree on. Two copies of
  a compatibility list is how one of them silently stops matching and a file
  list never refreshes, with no error anywhere. The old tag stays readable
  forever, and unlike the retired `document://` scheme it has live values
  behind it: `"document"` is what every release up to and including
  `v1.0.0-beta.51` wrote, a `run_logs` row is immutable once written, and the
  run page renders rows the current build never emitted.
- **`isFileProducedByRun`, `AGENT_OUTPUT_FILE_PURPOSE`** (`./file-uri`) — the
  one predicate answering "was this file row produced by this run, as opposed
  to merely consumed by it". Both halves of the pair are load-bearing:
  `GET /api/files?run_id=X` answers the run's whole CONTAINER, so a file
  chained in from an earlier run still carries `purpose: "agent_output"`, while
  an upload made FOR this run carries this run's id under
  `purpose: "user_upload"`. It had three independent implementations (the run
  page, the chat module's run card, the server-side `run_and_wait` payload) kept
  in step by a comment naming the other two; they now share this one. Lives in
  `./file-uri` for the same reason `PUBLISHED_FILE_LOG_EVENTS` does — a package
  may not import from `apps/web`, but all three can import core.
- **`./input-resolution`** — the platform's input resolution, previously
  private to `apps/api` and re-implemented by the CLI down to a byte-identical
  error message. `resolveEffectiveInput` collapses author defaults
  (`authorDefaults`), the editor's stored values and an ordered list of
  `overlays` into what a run executes with; `assertFieldsUnlocked` and
  `withoutLockedFields` are the two rules around locked fields. The overlays are
  a LIST rather than named fields because the hosts do not have the same layers:
  the platform resolves a scheduled trigger's frozen values under the caller's
  input, a local `appstrate run` has no schedules at all, and a named
  `scheduleValues` would leave the CLI carrying a field it can never fill. The
  refusal is injected (`lockedFieldError`) so each host keeps its own error
  surface — `ApiError(400, "locked_input_field")` on the platform, a CLI error
  type locally — without re-deriving the rule.
- **`compileCached`, `MAX_CACHED_VALIDATORS`** (`./schema-validation`) — the
  module's compiled-validator cache, exported so `apps/api`'s three server-only
  validators compile through it instead of standing up a second Ajv instance.
  The second instance had diverged: no `removeSchema`, so its registry grew
  unbounded in a long-lived process and a schema carrying `$id` threw the second
  time it was compiled; and it evicted by clearing the whole map rather than
  FIFO.
- **`ACCEPTED_RUNTIME_TOOL_IDS`, `canonicalizeRuntimeToolIds`**
  (`./runtime-tools-catalog`) — the set of `runtime_tools` ids a PERSISTED
  manifest may carry, and the one helper every read path funnels stored ids
  through. It drops ids the platform does not know, collapses duplicates,
  preserves the author's order, and — the part that matters — REPORTS every
  drop to its caller rather than swallowing it.

  An alias table (`LEGACY_RUNTIME_TOOL_ALIASES` and friends, mapping the
  retired `publish_document` forward to `publish_file`) was drafted for this
  release and removed again before it shipped, so it never reached npm and
  needs no deprecation. Nothing carries the retired spelling: no system
  package, no stored manifest. An unknown id is now refused on author input
  and dropped-with-a-report on read — never guessed at.

- **`./image-ref`** — the image-reference parser and the runtime-image version
  contract, added after `7.0.0` was published and undocumented here until now.
  `parseImageRef` splits a ref into repository / tag / digest;
  `findRuntimeImageTagMismatch(trio)` compares the platform's own version
  against the `PI_IMAGE` and `SIDECAR_IMAGE` tags and reports which member
  stands alone; `OCI_REVISION_LABEL` is the label the complementary
  same-tag-two-builds check reads. Types: `ParsedImageRef`, `RuntimeImageTrio`,
  `RuntimeImageMember`, `RuntimeImageTagMismatch`. `packages/env` composes the
  operator wording; the rule and both its carve-outs live here.

### Changed

- **`./document-uri` → `./file-uri`**, with the symbol renames listed above.
  No deprecated subpath alias is kept: the module is consumed in-tree only, and
  both out-of-tree consumers stay on the published version.
- **`findImageTagMismatch` → `findRuntimeImageTagMismatch`** (`./image-ref`),
  and it now takes the whole trio — `{ platformVersion, piImage, sidecarImage }`
  — rather than the two image refs. The old signature compared the pair to
  itself, so a platform at version X with both runtime images at X−1 passed. A
  platform version that is absent, empty or `dev` means "no release identity"
  and drops out of the comparison, degrading the rule to exactly the pair rule;
  a digest-pinned ref on either image still silences it entirely. The returned
  `oddOneOut` names the member whose value stands alone, which is NOT
  necessarily the thing to fix: a platform at X against a matched pair at X−1
  reports `"platform"`, and the fix there is to move the two images. Both names
  are post-`7.0.0`, so nothing published ever saw the old one.
- **`publish_document` → `publish_file`** — the runtime tool id, with
  `buildPublishDocumentDef` → `buildPublishFileDef`, `DocumentUploader` →
  `FileUploader`, `PublishedDocument` → `PublishedFile`,
  `DocumentPublishedEvent` → `FilePublishedEvent` (field `document_id` →
  `file_id`), `documentPublishedEvent` → `filePublishedEvent`, and the canonical
  event `document.published` → `file.published`. The legacy tool id is accepted
  on any persisted manifest and normalized to the canonical one by
  `validateManifest` / `dropRetiredRuntimeTools`; a manifest saved afterwards
  writes only `publish_file`, and a manifest naming both collapses to one entry.
- **`CoreResources.documents` → `CoreResources.files`** (`./permissions`), with
  `documents` removed from `CORE_RESOURCE_NAMES`. A stored `documents:read` /
  `documents:delete` scope no longer grants anything — see Removed.
- **`documentCountExceeded` → `fileCountExceeded`** (`./api-errors`), problem
  code `document_count_exceeded` → `file_count_exceeded`.
- **`recordDocumentCreated`, `recordDocumentDeleted`,
  `recordDocumentStorageLimitRejection`, `recordDocumentPartialPublication` →
  `recordFile*`** (`./telemetry`), metrics `appstrate.documents.*` →
  `appstrate.files.*`. Same rename on the `TelemetryProvider` interface.
- **`PlatformServices.cleanupSessionDocuments` → `cleanupSessionFiles`** and
  **`PlatformServices.setDocumentStorageLimit` → `setFileStorageLimit`**
  (`./module`).
- **`RunAndWaitDocument` → `RunAndWaitFile`**, **`fetchRunDocuments` →
  `fetchRunFiles`**, **`runAndWaitStepsWithDocuments` →
  `runAndWaitStepsWithFiles`** (`./run-and-wait-client`). The tool argument
  `context_documents` becomes `context_files`, the terminal payload key
  `documents` becomes `files`, the inline default `runtime_tools` selects
  `publish_file`, and the client calls `GET /api/files`.
- **`schema/agent.schema.json`** — the `runtime_tools` enum lists the canonical
  ids only. `publish_document` is not among them: an author manifest naming it
  fails validation, and a stored one has it dropped and reported.

### Removed

- **`mergeWithDefaults`** (`./form`) — replaced by `authorDefaults`. It
  materialised `null` for every declared property without a `default` and
  dropped undeclared caller keys, so a local `appstrate run` diverged from the
  same bundle on a platform.
- **`deepMergeConfig`** (`./schema-validation`) — nothing deep-merges any more.
  Input resolution is a shallow per-property overlay of four layers, which is
  what makes "which layer did this value come from" answerable at every call
  site. Its prototype-pollution guard goes with it because the recursion it
  guarded is gone, not because the concern was dismissed: a shallow spread of a
  `JSON.parse`d object cannot write through `__proto__`.
- **`validateConfig` / `ConfigValidationResult`** (`./schema-validation`) —
  renamed, see Added.
- **`LEGACY_PERMISSION_RESOURCE_ALIASES`, `canonicalPermission`,
  `canonicalPermissions`, `acceptedPermissionSpellings`** (`./permissions`) —
  the retired permission-resource table and the normalizer for stored scope
  strings, together with the second-chance branch inside `makePermissionGuard`
  that accepted a retired spelling directly. All three permission guards
  (`requirePermission`, `requireCorePermission`, `requireModulePermission`)
  delegate to that guard, so the removal reaches every one of them: a
  `documents:read` scope is now denied where `files:read` is required, along
  with the near-misses `file:read`, `files` and `files:read:extra`, and the
  denial is pinned unit-level for all three.

  This one has a caller behind it and the trade is deliberate. The alias never
  shipped — it was added and removed inside this unreleased window — but
  `documents:*` **is** the spelling every released Appstrate advertised, so a
  third-party OAuth client integrated against `v1.0.0-beta.51` holds it in
  config and now gets `invalid_scope` rather than a silent rewrite. For a beta
  with no production data a loud refusal is the right failure and a silently
  under-granted scope is not. Read-time normalization is also a translation
  layer that would have to be applied at every site forever, and each site that
  forgets it degrades silently: the scope is not rejected, it is dropped, and
  the credential merely does less than it was granted. Three platform tests
  were passing only because of the alias, which is the finding that justifies
  the removal on its own.

- **`LEGACY_RUNTIME_TOOL_EVENT_TYPES`** (`./runtime-tool-defs`) — the
  retired `document.published` runtime-tool event type. Its removal is safe for
  a structural reason rather than a version one: the only producer of that name
  is core's own `filePublishedEvent`, bundled into the SAME artifact as the
  trust-boundary acceptor that consumes it, so there is no version boundary
  between them and the retired name can now only arrive from a forged upstream
  event — which is what that acceptor's drop is for. Also post-`7.0.0` on both
  ends.
- **`LEGACY_DOCUMENT_URI_PREFIX`, `ACCEPTED_FILE_URI_PREFIXES`**
  (`./file-uri`) — the `document://` scheme and the accept-list that carried
  it. It survived to read historical rows, and finishing the rename at the
  physical layer made it unreachable: every URI ever written under the old
  scheme addresses a `doc_` id, and `FILE_ID_RE` accepts only `file_`. The one
  pair the accept path could still have matched — `document://` + `file_…` — is
  a form no build has ever emitted, since the scheme was replaced while ids
  were still `doc_`. A `document://` value now fails at `parseFileUri` instead
  of one line later on the id, in the same rejection.
- **`swapRequestModel`** (`./model-swap`) — the alias→real request-body rewrite.
  Its last caller was deleted with the alias-opacity change (#1202); the
  adaptive-Anthropic branch it still carried had become a second implementation
  of the live `compat: { forceAdaptiveThinking: true }` path. Verified to have
  no reader in this repo, in `cloud`, or in `connect-helper`. Every other
  `./model-swap` export is untouched.
- **`InlineRunBody.config`** (`./platform-types`) — the inline-run routes no
  longer accept the field.
- **`publish_document.presentation`** (`./runtime-tool-defs`) — the
  `presentation: "primary"` argument, the `presentation` field on
  `PublishedDocument` / `DocumentPublishedEvent` (now `PublishedFile` /
  `FilePublishedEvent`), and the primary-selection rule the tool description
  carried. It conflated how important a file is with whether the UI opens it,
  allowed at most one per run, and made the producing agent arbitrate a
  presentation decision that was never its call — an agent writing three peer
  files had to crown one or leave the run looking empty. Which file a run
  features is now derived by the consumer from what the run produced (0 → none,
  exactly 1 → that one, N → none), so core neither declares nor transports it.
  `buildPublishFileDef` reads only `path` and `name`; an undeclared key, the
  retired `presentation` included, is ignored rather than rejected — losing a
  real deliverable over a dead argument would be the worse failure.

## [7.0.0] — 2026-08-21

Breaking release. Adds two names, and removes six with zero consumers anywhere — verified
across this repo and both out-of-tree consumers (`cloud`, `connect-helper`),
which import only `module`, `logger`, `api-errors`, `telemetry`, `permissions`
and `pairing-token`. Neither needs a code change; the lockstep is a version
bump on each side.

### Added

- `MODEL_API_SHAPES` (`./sidecar-types`) — the runtime array `ModelApiShape` is
  now derived from. See the `Changed` note below for why the type-only union
  was not enough.
- `OrchestratorRegistration.appliesWorkspaceTmpfsCap?: boolean`
  (`./platform-types`) — lets a backend declare that it enforces the workspace
  tmpfs size cap itself, so the prompt builder can tell the agent whether the
  cap is real. Optional, so existing out-of-tree registrations stay assignable.

### Removed

- `isFinalChatStep` (`./chat-turn-metadata`) — its only caller was the AI-SDK
  step loop deleted in #1173.
- `normalizeToolName` (`./naming`) — superseded by the
  `normaliseMcpToolNamespace` / `normaliseMcpToolBody` pair this same module
  already re-exports from `@appstrate/afps-shared`; the single-function
  normalizer was a strictly weaker version of the split.
- `isApiUploadToolName` (`./integration`) — the twin `isApiCallToolName` is
  live; this one never had a caller.
- `IntegrationUploadProtocol` (`./integration`) — an alias for a bare `string`,
  referenced once. Use `string[]`.
- `RunConnectionMissingError` (`./module`) — an alias of `ValidationFieldError`
  used once, in its own file. Use `ValidationFieldError`.
- `WorkloadResources.pidsLimit` (`./platform-types`) — no producer ever set it,
  so the Docker backend's own 256 default was always the effective policy.

### Changed

- `RunOrchestrator.stopWorkload(handle, timeoutSeconds?)` →
  `stopWorkload(handle)`, and `stopByRunId(runId, timeoutSeconds?)` →
  `stopByRunId(runId)`. The parameter was `undefined` at every production entry
  point, so every backend fell back to its own 5-second SIGTERM grace — now
  stated once, as a single `SIGTERM_GRACE_SECONDS` the docker, process and
  firecracker backends all read. Out-of-tree implementers stay
  assignable: an implementation that still declares the optional parameter
  satisfies the narrowed signature.
- `ModelApiShape` (`./sidecar-types`) is now derived from a new exported
  runtime array, `MODEL_API_SHAPES`. It was a type-only union, which forced
  consumers needing a runtime list to hand-mirror it —
  `runtime-pi/env.ts` did, guarded by `satisfies readonly ModelApiShape[]`.
  That guard proves membership, never completeness, so adding a shape here and
  emitting it from the platform typechecked green everywhere and then threw
  `MODEL_API: unknown api` at every container boot.

### Fixed

- `getTraceContext` (`./logger`) kept, but its docstring no longer claims it is
  "useful when forging child spans for outbound HTTP calls" — nothing ever did
  that. It is the read counterpart of `runWithTraceContext` and the observation
  port the observability module's tests use.

### Release order

`@appstrate/afps-shared@0.4.0` MUST be published before this release: core's
`./mime` is now a verbatim re-export of the new `@appstrate/afps-shared/mime`
subpath, which does not exist in the published 0.3.1. The dependency range here
moved to `^0.4.0` accordingly.

## [6.2.0] — 2026-08-07

Additive release. Four export subpaths landed in `packages/core/src` after
`6.1.0` without a version bump — `./package-files`, `./mcp-server-meta`,
`./model-generation` and `./url`. The code is on `main`, but npm's `6.1.0`
tarball does not carry them, so none of the four can resolve for a consumer
that installs core from the registry, whatever range it declares. No export
was removed, so a **minor**.

### Added

- **`@appstrate/core/package-files`** — `PACKAGE_FILE_INLINE_MAX_BYTES`, the
  inclusive size ceiling above which the file explorer neither inlines a file
  server-side nor previews it client-side, and `PACKAGE_CONTENT_ENTRY`, the
  archive entry holding each package type's primary content: its `path`
  (`prompt.md`, `SKILL.md`, `INTEGRATION.md`, and `null` for `mcp-server`,
  whose content _is_ its manifest) together with whether that entry is
  `required`. `PACKAGE_CONTENT_FILE` is the name-only projection of the same
  table, derived rather than declared, so the two cannot drift; readers that
  need only the filename keep using it unchanged. These facts previously had
  independent declarations kept in manual lockstep, where a drift would either
  erase a real file or invent one the package does not ship. Free of value
  imports by design — the SPA bundles it.
- **`@appstrate/core/mcp-server-meta`** — `MCP_SERVER_APPSTRATE_META_KEY`,
  `MCP_SERVER_RUNTIME_CAPABILITIES`, `MCP_SERVER_RUNTIMES`,
  `isMcpServerRuntime()`, `getMcpServerRuntime()` and the `McpServerRuntime`
  type. All of them are re-exported from `@appstrate/core/mcp-server`, so
  backend callers are unaffected and each fact is still declared exactly once.
  The split exists for bundlers: `./mcp-server` pulls in `@afps-spec/schema`,
  which constructs an Ajv instance at module scope and ships no
  `sideEffects: false`, costing the SPA 65 kB gzipped for what is only a
  runtime label.
- **`@appstrate/core/model-generation`** — temperature and reasoning settings
  as a shared contract: `modelGenerationSettingsSchema`,
  `modelGenerationCapabilitiesSchema`, `resolveModelGenerationSettings()`,
  `reconcileModelGenerationSettings()`,
  `applyModelGenerationCapabilitiesOverride()`,
  `toNativeModelReasoningLevel()`, `anthropicReasoningBudgetTokens()`,
  `ModelGenerationError` and the `MODEL_REASONING_LEVELS` catalog. Capability
  support is tri-state (`supported | unsupported | unknown`) so a model whose
  support cannot be established is not reported as unsupported.
- **`@appstrate/core/url`** — `normalizeHttpUrl()`, which parses an absolute
  URL and returns its WHATWG-normalized href when the protocol is `http:` or
  `https:`, and `null` otherwise. It settles URL syntax and the protocol
  allowlist and nothing else: it is deliberately NOT an origin-trust or SSRF
  decision, and a caller with either requirement must still apply its own
  policy on top.
- `publish_document.presentation: "primary"` — lets an agent explicitly select
  the run's featured deliverable after writing its final bytes. The published
  document and `document.published` event carry the selected presentation. The
  public uploader keeps its existing positional signature with an optional
  third argument, so existing 6.x consumers remain source-compatible.
- `@appstrate/core/platform-types` — `InlineRunBody.connection_overrides`, the
  flat `{ "@scope/integration": "<connection_id>" }` map (resolver mechanism #2).
  `POST /api/runs/inline` and `/inline/validate` read it, so an inline caller can
  escape a `412 must_choose_connection` by re-posting its pick — until now that
  remedy existed only on the cataloged run route. Optional and NOT nullable:
  both routes reject an explicit `null` on the wire.

### Changed

- `@appstrate/core/run-and-wait-client` — inline `run_and_wait` accepts a
  partial canonical AFPS manifest. It derives `name` from `display_name` and
  fills omitted boilerplate, runtime tools, and an open output schema. The
  materialization is deliberately shallow: every supplied top-level field is
  preserved exactly, including nested deterministic schemas and
  `runtime_tools: []`; no runtime capability is injected into an explicit
  selection.

- `@appstrate/core/run-and-wait-client` — `launchRunAndWait` forwards the new
  `connection_overrides` argument on BOTH kinds (`agent` and `inline`), and
  refuses it pre-dispatch whenever it is present but is not a plain object
  (a JSON-encoded string, an array, a number, a boolean, `null`). A dropped map
  produces the identical `412` on retry with nothing saying the argument was
  ignored, so the refusal — with a message naming the mistake — is the only
  signal the caller can act on.

### Fixed

- `publish_document` now carries the complete conditional primary-selection rule in its shared
  tool descriptor, so named agents and inline runs receive identical guidance whenever the
  capability is available. `run_and_wait` no longer rewrites prompts with a second copy of that
  policy.

- `@appstrate/core/run-and-wait-client` — `fetchRunDocuments` now returns only
  the documents the run itself produced. `GET /api/documents?run_id=…` answers
  the run's whole document CONTAINER, inputs included, and a `document://`
  chained in from an earlier run keeps `purpose: 'agent_output'` — so the
  purpose filter alone let a previous run's output be reported (and rendered in
  the chat run card) as this run's deliverable. Rows are now kept only when
  their own `run_id` matches.

## [6.1.0] — 2026-07-29

Additive release. It exists because `packages/core/src` had drifted from the
published `6.0.0` by 191 lines while carrying the same version number — npm and
the in-tree source were no longer the same code under the same label, which is
invisible to anyone consuming core from the registry.

### Added

- **`findRetiredDependencyKeys()`**, plus the `RetiredDependencyKey` and
  `RetiredDependencyKeyUse` types (`@appstrate/core/dependencies`). Lists the
  AFPS 1.x `dependencies` keys that AFPS 2.0 retired, each paired with its
  replacement: `tools` → `mcp_servers`, `providers` → `integrations`. Pure and
  non-mutating — it reports what it found and decides nothing, so callers apply
  the direction-dependent policy themselves (reject on author input, warn and
  never rewrite on already-persisted manifests).
- **`totalTokens()`** (`@appstrate/core/token-usage`). Sums a `TokenUsage`
  across all four counters, cache creation and cache read included. Summing
  only `input_tokens + output_tokens` under-reports every cached turn.
- **`LlmUsageLedgerRow.pricingStatus`** (`@appstrate/core/module`), optional,
  `"priced" | "partial" | "unpriced" | null`. Lets a reader distinguish a row
  priced at zero from a row whose price could not be resolved — previously
  indistinguishable, both surfacing as `0`.

### Changed

- **`validateManifest()` under `retiredRuntimeTools: "reject"` now also rejects
  retired `dependencies` keys**, naming the replacement key in the error.
  Author input carrying `dependencies.tools` or `dependencies.providers` was
  silently accepted and then inert; it now fails at authoring time.

  Note the asymmetry, which is deliberate: this is a policy on author input,
  not a shape constraint. `dependencies` stays a loose object (AFPS §10
  mandates extensibility for objects it does not explicitly close), so
  **already-published manifests carrying a retired key keep validating and keep
  running**. Only the `"reject"` policy path is affected — a caller that
  previously passed such a manifest through `validateManifest` and got a pass
  will now get a failure.

## [6.0.0] — 2026-07-26

Major release grouping every contract change the repository accumulated after
`5.0.0` into ONE coordinated break, so consumers pay a single lockstep cycle:
the `report` runtime tool is retired in favour of published documents,
`checkUsageAllowed` gains a required argument, two module-contract signatures
that were optional-but-always-supplied become required, a model provider's
`featuredModels` / `modelDiscoveryCandidates` widen to `ModelIdSelection` and
break every READER of those fields, `ChatTurnFinishReason` gains a `"deadline"`
member that breaks exhaustive switches, `isFinalChatStep` loses its `maxSteps`
parameter, and a set of exports with no importer anywhere is deleted.

> **How this one shipped:** published 2026-07-27 through the
> `CONSUMER_DRIFT_POLICY=warn` bypass — variable set, tag pushed, variable
> deleted immediately. The `X.0.0` carve-out did not exist yet, and three
> consumers (`registry`, `portal`, `connect-helper`) were four majors behind on
> a list that still included them. The procedure lives in
> [`docs/deployment/RELEASING_CORE.md`](../../docs/deployment/RELEASING_CORE.md).

> **Deploy ordering — modules BEFORE the platform**, for the same reason as
> `5.0.0`: a module implementing `beforeUsage` / `checkUsageAllowed` must be on
> this contract before the platform starts passing the new `subscription` fact.

### Added

- **`CORE_VERSION`** (`@appstrate/core/module`) — the core version this build
  ships, as a string literal (`"6.0.0"`). A module author does not read it; the
  host platform does, to check it against the range each loaded module declares.
  It is hardcoded rather than imported from `package.json` because core is
  consumed over npm by repos where an ESM JSON import is a portability hazard,
  and `packages/core/test/core-version.test.ts` asserts it equals the published
  `version` so it cannot drift.

- **`@appstrate/core/oauth-bearer-swap`** — `ANTHROPIC_OAUTH_PLACEHOLDER_API_KEY`
  (`"sk-ant-oat01-placeholder"`). The placeholder `apiKey` handed to pi-ai for
  an Anthropic OAuth subscription binding on every path where the real token is
  swapped in later (the run path's sidecar `/llm` branch, the CLI's llm-proxy
  preset path). It lives beside the swap that consumes it so the producers and
  the consumer agree on one literal: pi-ai's `anthropic-messages` provider
  selects the OAuth request shape from `apiKey.includes("sk-ant-oat")` alone, so
  a placeholder missing that marker silently emits the api-key shape and
  upstream rejects it. Non-breaking; nothing existing changes meaning.

- `@appstrate/core/chat-turn-metadata` — the chat turn's TIME budget alongside its
  existing step budget: `CHAT_TURN_DEADLINE_MS`, `CHAT_TURN_SAFETY_MARGIN_MS`,
  `CHAT_MIN_RUN_BUDGET_MS`, `CHAT_LAUNCH_THRESHOLD_MS`, plus the pure
  `computeTurnRunBudget()`, `formatBudgetDuration()` and `formatTurnBudgetNote()`.
  Both chat engines derive a child call's wait from an absolute turn deadline
  instead of silently taking `RUN_AND_WAIT_MAX_MS` (30 min), which is three times
  longer than a turn.

- `@appstrate/core/bearer` — `parseBearer()`, the `Authorization` header parser
  the module-authoring contract now points `authStrategies()` at: RFC 9110 §11.4
  makes the auth-scheme a case-insensitive token separated from the credentials
  by `1*SP`, so a conformant `authorization: bearer ey…` must match, which
  `startsWith("Bearer ")` rejects. First release carrying the subpath — a module
  built against an earlier core must parse the header itself.

- `@appstrate/core/run-and-wait-client` — `RUN_RESULT_INLINE_MAX_BYTES` (32 KB) and
  `truncateRunAndWaitPayload()`: a run result over the cap is cut to a usable
  head that points back at the run, whose
  `runs.result` already holds the whole payload (`getRun` returns it) — no copy is
  made. `launchRunAndWait` forwards the new `context_documents` argument (inline
  runs only).

- `@appstrate/core/module` — `CatalogModelSelector`, `ModelIdSelection` and the
  `isCatalogModelSelector()` narrowing guard: a model provider can declare its
  model lists as `{ catalogFamilies, generations }` instead of enumerating ids.
  The platform resolves a selector against its vendored pricing catalog on every
  read, so a new vendor generation reaches the picker with the weekly catalog
  refresh and no module edit. Meant for providers that track the vendor's
  current generation and cannot probe (`claude-code`); an explicit array stays
  right when the served set is defined outside the catalog (`codex`).

### Changed

- `buildPublishDocumentDef()` — the `publish_document` tool description now leads with what
  only the tool can do (publish DURING the run, get the durable `document://` URI back) instead
  of steering agents away from it. The `outputs/` sweep is unconditional and shares the same
  uploader, so the previous "use this tool only to publish a deliverable that lives elsewhere in
  the workspace" named the one replaceable case and hid the reason to call it at all. Behaviour
  and schema are unchanged.

### Changed (BREAKING)

- **`PlatformServices.checkUsageAllowed` gains a required `subscription: boolean`.**
  The full argument shape is now
  `{ orgId, presetId, sessionId, subscription }`. It is the one fact the caller
  owns and the platform cannot derive: the turn runs on a provider subscription
  the organization authorized over OAuth (claude-code, codex), driven in-process
  rather than through the inference gateway. Such a turn is
  `credentialSource: "org"` whatever its preset resolves to, and it is now
  dispatched like any other — it still occupies the platform's own process.
  **Every implementer must widen its parameter type**; every caller must pass
  the field. This is what forces the major.

- **`validateManifest(raw, options?)` — unknown `runtime_tools` handling is now
  DIRECTIONAL, and the default still rejects.** For `type: "agent"`, ids absent
  from `SELECTABLE_RUNTIME_TOOLS` fail validation as before **unless** the
  caller passes `{ retiredRuntimeTools: "drop" }`, in which case they are
  filtered out of the parsed manifest and it stays valid.

  Both behaviours are needed, and which one is correct depends entirely on
  where the manifest came from. **Author input** (create, update, import, an
  inline manifest from an API client) must reject: `runtime_tools: ["lgo"]` is
  a typo, and silently dropping it ships an agent missing its tool with no
  signal to anyone. **Already-persisted manifests** (a stored draft, a
  published version snapshot) must drop: a removal is not retroactive, a
  published ZIP is immutable by construction, and a hard enum rejection on the
  run path would make every such agent permanently unrunnable — the runtime
  itself already ignores ids it cannot build (`buildRuntimeToolDefs`).

  On the `valid: true` branch the result now carries
  **`droppedRuntimeTools: string[]`** (always `[]` under the default policy) so
  the drop is observable instead of silent.

  Migration: a consumer that validates author input needs no change. A consumer
  that re-validates something it stored must pass
  `{ retiredRuntimeTools: "drop" }` or it will start rejecting its own
  historical rows. The returned manifest object is the same reference when
  nothing needed dropping.

- **`dropRetiredRuntimeTools(manifest)` is exported** from
  `@appstrate/core/validation`:
  `(manifest: Record<string, unknown>) => { manifest, dropped: string[] }`.
  The same filter `validateManifest`'s `"drop"` policy applies, usable without
  a full validation pass — deliberately structural, with **no Zod round-trip**,
  so key order, unknown fields and the absence of schema defaults survive
  byte-for-byte. That matters for the version-snapshot path, which serialises
  the result into an integrity-hashed artifact: a re-parse that reordered keys
  would silently defeat publish dedup. Non-agent manifests are returned
  untouched. When the filter empties the list, the `runtime_tools` **key is
  removed** rather than left as `[]`: AFPS makes the field optional with no
  default so both parse alike, but they are different bytes, and the agent
  editor's own writer (`setRuntimeTools`) already drops the field on an empty
  selection. Emitting `[]` would give one manifest two integrity hashes
  depending on which path last wrote it.

- **`ModuleInitContext.getOrgName` is required** (was `getOrgName?`). The
  platform has always supplied it (`buildModuleInitContext`), and the optional
  marker only forced every consumer through a `?.` / `!` it could never
  actually need. Modules can call it unconditionally; anything CONSTRUCTING a
  `ModuleInitContext` (module test fakes, essentially) must now provide it.

- **`ModuleHooks.beforeSignup` / `afterSignup` — the `ctx` argument is required**
  (was `ctx?`). Signatures are now
  `(email: string, ctx: BeforeSignupContext) => Promise<void>` and
  `(user: { id, email }, ctx: AfterSignupContext) => Promise<void>`. Both hooks
  have always been dispatched with a context (`ctx.headers` is `null`, not the
  context itself, when Better Auth creates a user outside an HTTP request), and
  the platform's own injection slots already typed it non-optional internally.
  An implementer written against the old signature keeps compiling
  (`ctx?: T` is assignable to `ctx: T`); what changes is that `ctx?.headers`
  and `ctx | undefined` narrowings are now dead code, and any direct
  `callAllHooks("beforeSignup", email)` call must pass the context.

- **`@appstrate/core/zip` — `parsePackageZip` takes an options object, and
  `ParsedPackageZip` gains a required `droppedRuntimeTools: string[]`.** The
  second parameter is now `number | ParsePackageZipOptions`: the bare-number
  form is the original published signature and still reads as `maxSize`, so
  existing calls keep working. The new object form adds `retiredRuntimeTools`,
  which is forwarded verbatim to `validateManifest` and **defaults to
  `"reject"`** — a ZIP is author input unless the caller knows otherwise.

  Pass `"drop"` only for an archive the platform already holds and cannot
  repair in place. In this repo exactly one call site qualifies: the bundle
  installer, which re-ingests what `GET /api/agents/:scope/:name/bundle`
  produced. Without it, an agent published while `report` was still selectable
  could not be re-imported — the artifact is immutable by construction, so the
  400 had no remedy. `POST /api/packages/import` deliberately stays on
  `"reject"`: it shares its parser with `/import-github`, which fetches
  hand-written source, and the policy cannot tell a retired id from a typo.

  What breaks is only the output type. Reading `ParsedPackageZip` is
  unaffected; **constructing one as a literal now needs the new field**
  (`droppedRuntimeTools: []` for a synthesised manifest). It is required rather
  than optional so readers never need a `?? []`.

- **`@appstrate/core/chat-turn-metadata` — `isFinalChatStep` loses its
  `maxSteps` parameter.** The signature is now `(stepNumber: number) => boolean`
  and the function reads `CHAT_MAX_STEPS` directly. The parameter defaulted to
  that same constant and no call site ever passed anything else, in this
  repository or outside it — an option with one possible value is not
  flexibility, it is a second place the step ceiling can be stated. Callers
  passing the constant explicitly drop the argument; callers already relying on
  the default are unaffected. Landed inside this major precisely because it is a
  source break on a symbol that shipped in `5.0.0` (see #1010).

- `ChatTurnFinishReason` gains `"deadline"` — a turn cut by the engine's
  wall-clock ceiling is no longer disguised as its last step's provider reason.
  Breaking for readers: widening the union stops any exhaustive `switch` over it
  from compiling until the new member is handled.

- `ModelProviderDefinition.featuredModels` widens from `readonly string[]` to
  `ModelIdSelection` (`readonly string[] | CatalogModelSelector`), and
  `modelDiscoveryCandidates` with it. **Asymmetric for consumers**: a module
  that only WRITES these fields — every module passing an array — compiles
  unchanged, since the array arm is unchanged. Code that READS
  `def.featuredModels` as a `string[]` (mapping, spreading, `.includes()`) stops
  compiling and must narrow with `isCatalogModelSelector()` first, or resolve
  the selection platform-side.

### Removed (BREAKING)

- **The `report` runtime tool is gone.** It was a deprecated compatibility
  shim whose replacement is a published document (`outputs/report.md`, or the
  `publish_document` tool). Concretely:
  - `EVENT_EMITTER_RUNTIME_TOOLS` no longer contains `"report"`, so
    `EventEmitterRuntimeTool` and the derived `SELECTABLE_RUNTIME_TOOLS` /
    `SelectableRuntimeTool` narrow accordingly.
  - `CANONICAL_RUNTIME_TOOL_EVENT_TYPES` no longer contains `"report.appended"`.
  - `agentManifestSchema`'s `runtime_tools` enum and the published
    `schema/agent.schema.json` enum no longer accept `"report"`.

  A stored manifest still naming `report` remains **runnable** — read paths
  validate with `{ retiredRuntimeTools: "drop" }` (above) and
  `buildRuntimeToolDefs` ignores the id. A manifest _submitted_ naming
  `report` is rejected, like any other unknown tool id. What breaks is code
  that references the literal:
  a consumer typing a variable as `EventEmitterRuntimeTool = "report"`, a
  handler switching exhaustively on `CANONICAL_RUNTIME_TOOL_EVENT_TYPES`, or a
  validator asserting the old enum contents.

- **`@appstrate/core/errors` — `AppError` and `createErrorStatusMap` removed.**
  No importer anywhere in the platform; the RFC 9457 `ApiError` family in
  `@appstrate/core/api-errors` is the error contract. `getErrorMessage` is
  unaffected and stays.

- **`@appstrate/core/api-errors` — `serviceUnavailable()` removed.** No caller
  ever emitted a 503 through it. `badGateway()` (502) is live and stays.

- **`@appstrate/core/platform-types` — the `Run` and `RunLog` interfaces
  removed.** Public DTO shapes with no importer: every consumer of this subpath
  imports orchestrator/workload/pub-sub types instead, and a module that reads
  run rows does so through `PlatformServices`. Nothing else in the file
  referenced them.

- **`@appstrate/core/naming` — `TOOL_NAME_INNER_PATTERN` removed.** It was a
  pure alias of `CREDENTIAL_KEY_RE`, kept for a consumer that no longer exists.
  Use `CREDENTIAL_KEY_RE` — same regex, same alphabet.

- **`@appstrate/core/chat-turn-metadata` — `CHAT_TOOL_STEP_BUDGET_DENIAL`
  removed.** Unused prompt string. Its three siblings (`CHAT_MAX_STEPS`,
  `CHAT_TOOL_STEP_BUDGET`, `CHAT_FINAL_STEP_SYSTEM_PROMPT`) are live and stay.

- **`@appstrate/core/validation` — `PACKAGE_TYPES` removed.** It was
  `packageTypeEnum.options` under another name. Use
  `packageTypeEnum.options` (the enum itself is live and re-exported from
  `@afps-spec/schema`).

- `appendFinalStepSystemPrompt()` — the final-step directive is now carried as a
  separate system block rather than concatenated, leaving this with no importer.

- **`@appstrate/core/semver` — `satisfiesRange()` removed.** No caller.
  `matchVersion`, `isValidRange`, `normalizeVersion`, `compareVersionsDesc`,
  `bumpVersion`, `bumpPatch` are unaffected.

- **`@appstrate/core/companion-files` (whole subpath) removed.** It was a
  100% re-export of `@appstrate/afps-shared/companion-files` with no importer.
  Import from `@appstrate/afps-shared/companion-files` directly — identical
  surface (`CompanionViolationReason`, `CompanionFileViolation`,
  `CompanionFileSource`, `companionFilesFromMap`, `companionFilesFromRecord`,
  `checkCompanionFiles`).

- **`@appstrate/core/credential-template` (whole subpath) removed.** Same
  profile — a pure re-export. Import from
  `@appstrate/afps-shared/credential-template` (`CREDENTIAL_REF`,
  `RenderCredentialTemplateOptions`, `renderCredentialTemplate`).

  `@appstrate/core/ssrf` is the third file of this shape and is deliberately
  **kept**: it has ~20 live importers on fail-closed SSRF paths, and churning
  them buys nothing.

## [5.0.0] — 2026-07-25

Major release: the durable **documents** surface (URIs, storage enumeration +
download presign, filename transport, RBAC resource, telemetry, the
`publish_document` runtime tool), a **module-contract cleanup** that removes two
extension points with zero implementers and makes hook dispatch modes type-safe,
and **quote-based admission** — `beforeUsage` now reports neutral execution facts
for EVERY run and EVERY chat turn instead of firing only for operations the
platform had pre-classified as metered.

> **Release ordering.** Everything published between `core@4.0.0` and this tag
> shipped in the platform without a version bump — the surface below therefore
> accumulated across several PRs. `cloud` read `PlatformServices.setDocumentStorageLimit`
> through a structural cast with a silent degradation path (log once, then
> no-op) because the dependency range never moved past `^4.0.0`, so per-plan
> storage entitlements never applied. Bump every consumer (see
> `scripts/check-consumer-versions.ts`) and drop that cast.

> **Deploy ordering — modules BEFORE the platform.** `beforeUsage` now fires for
> operations it never fired for before (see Changed). A module still running the
> old code will be asked to admit operations it has no policy for, and — because
> the platform no longer decides on its behalf that an operation consumes
> nothing — will admit or reject them by accident. Deploy every module that
> implements `beforeUsage` on this contract first, then the platform.

### Added

- **`@appstrate/core/document-uri`** (new subpath) — the shared vocabulary for
  the durable document store: `DOCUMENT_URI_PREFIX`, `UPLOAD_URI_PREFIX`,
  `DOCUMENT_ID_RE`, `UPLOAD_ID_RE`, `isDocumentUri()`, `isUploadUri()`,
  `isAttachmentUri()`, `parseDocumentUri()`, `documentUri()`,
  `extractDocumentIds()`, `extractDocumentIdsFromText()`.

- **`@appstrate/core/storage`** — object enumeration + browser download.
  `Storage.listObjects(bucket, prefix?)` yields `StorageObject`
  (`{ key, size?, lastModified? }`) lazily, paginating internally (S3
  ListObjectsV2 continuation tokens, filesystem recursive walk), for the
  orphan-reconciliation operator tool. `Storage.createDownloadUrl(bucket, path,
opts?)` returns a browser-usable GET URL (S3 presign with
  `response-content-disposition` / `response-content-type` overrides via
  `CreateDownloadUrlOptions`), or `null` when the backend cannot produce one.
  `CreateUploadUrlOptions` gains `sha256` — a client-declared lowercase-hex
  digest bound server-side (`x-amz-checksum-sha256` signed into the presigned
  PUT; encoded into the proxy sink's signed token so the streamed bytes are
  re-hashed). Both backends (`storage-s3`, `storage-fs`) implement all three.

- **`@appstrate/core/naming`** — filename transport, shared because BOTH ends of
  the run-to-platform document channel must apply the same rule (the API
  sanitizes `X-Document-Name` into `documents.name`, which is part of the
  `(run_id, sha256, name)` dedup identity, and the agent container has to
  PREDICT that stored name): `MAX_FILENAME_LEN`, `sanitizeFilename()`,
  `encodeFilenameHeader()`, `decodeFilenameHeader()`.

- **`@appstrate/core/api-errors`** — `storageLimitExceeded()`,
  `documentCountExceeded()`, `checksumMismatch()`, `uploadStagingLimitExceeded()`.

- **`@appstrate/core/permissions`** — new core resource `documents`
  (`"read" | "delete"`), added to `CoreResources` and `CORE_RESOURCE_NAMES`.
  `read` gates the family the way `runs:read` gates runs; the per-document
  container ACL stays the fine-grained layer.

- **`@appstrate/core/telemetry`** — `StorageDeletionStats`,
  `recordStorageDeletionSweep()`, `recordStorageDeletionResult()`,
  `recordDocumentCreated()`, `recordDocumentDeleted()`,
  `recordDocumentStorageLimitRejection()`, `recordDocumentPartialPublication()`.
  The rejection counter is named for the thing it counts — a write refused by
  the per-org **byte ceiling** (403 `storage_limit_exceeded`) — not for a
  commercial allowance: core is Apache-2.0 and carries no billing vocabulary on
  its exported surface. The provider-side counter it feeds is
  `appstrate.documents.storage_limit_rejections`.

- **`@appstrate/core/runtime-tool-defs`** — the `publish_document` runtime tool:
  `PublishedDocument`, `DocumentPublishedEvent`, `documentPublishedEvent()`,
  `DocumentUploader`, `buildPublishDocumentDef(uploader)`. Unlike the pure event
  emitters it performs an HTTP upload, so it is built with an injected uploader
  in the runtime entrypoint rather than by `buildRuntimeToolDefs`.

- **`@appstrate/core/run-and-wait-client`** — `RunAndWaitDocument`,
  `fetchRunDocuments()`, `runAndWaitStepsWithDocuments()`.

- **`@appstrate/core/chat-contract`** — `ChatAttachmentRequest` /
  `ResolvedChatAttachment`: the plain-field shapes the chat module hands across
  `ctx.services` so the platform materializes an `upload://` (or validates a
  `document://`) server-side.

- **`PlatformServices.resolveChatAttachment()`** — materialize/validate a chat
  composer attachment into a stable `document://` URI.
- **`PlatformServices.cleanupSessionDocuments(chatSessionId, tx?)`** —
  detach-or-delete a deleted session's documents inside the caller's own
  transaction, so the teardown and the `chat_sessions` delete commit atomically.
- **`PlatformServices.setDocumentStorageLimit(orgId, bytes)`** — set/clear an
  org's document-storage byte ceiling, enforced by the platform inside its own
  document-write transaction.

- **`@appstrate/core/module`** — `FirstMatchHooks` / `BroadcastHooks` (see
  Changed).

- **`BeforeUsageParams` carries the operation's execution facts.** Both members
  of the union gain `credentialSource` and `executionPlane`; the `run` member
  also gains `timeoutSeconds`. They are FACTS, not verdicts — the module turns
  them into a policy decision. The widening is BREAKING for anything that
  CONSTRUCTS these params (module test fakes, essentially): the new fields are
  required. A hook that only READS its params keeps compiling.
  - **`credentialSource`** — whose credential is spent on inference.
    `"system"` (a platform-supplied credential: a `SYSTEM_PROVIDER_KEYS` entry
    or a system model preset), `"org"` (the organization spends its OWN
    credential — a BYOK API key or a provider subscription it authorized over
    OAuth), or, on `run` only, `null` when a remote-origin run resolves its
    model later on its own host. `null` is not a coverage gap: if such a run
    routes inference through the platform's system model proxy, that seam
    dispatches its own `beforeUsage` with a `credentialSource` that IS known
    there. The name matches the `llm_usage.credential_source` ledger column a
    metering module reconciles against; the `runs.model_source` database column
    is the same concept under an older, persisted name — deliberately not
    renamed.
  - **`executionPlane`** — whose compute runs the work. `"platform"` (a
    sandboxed container or microVM the platform operates, or the platform's own
    chat process) or `"remote"` (the caller supplies the host). Always
    `"platform"` on `chat`, and present rather than omitted there so a module
    can read the field off either member without first narrowing on `context`.
    Reported as an axis independent of `credentialSource` on purpose: an
    organization can spend its own credential and still occupy platform
    compute, or supply its own host while spending a platform-supplied
    credential. A module that collapses the two into a single signal mis-admits
    one of those combinations.
  - **`timeoutSeconds`** (`run` only) — the run's EFFECTIVE timeout in seconds,
    i.e. the agent's declared timeout after the platform ceiling has been
    applied. It is the upper bound on how long the run may occupy platform
    compute, NOT a prediction of its actual duration. `null` means "contribute
    nothing for compute here", and is deliberate rather than unknown: the
    system-proxy seam admits the inference of an ALREADY-RUNNING run whose
    compute was accounted for when the run itself was admitted (platform
    plane), or is not platform-supplied at all (remote plane). A consumer must
    NOT read `null` as "unknown, assume the worst" — that would account for the
    same run's compute twice. A module that does not account for duration can
    ignore the field entirely.

### Changed (BREAKING)

- **`beforeUsage` is dispatched for EVERY run and EVERY chat turn.** It
  previously fired only for an operation the platform had already classified as
  metered — in practice, only when the resolved model came from a
  platform-supplied credential; an operation on the organization's own
  credential never reached the hook at all. That classification hard-coded "the
  organization brings its own credential ⇒ nothing is consumed", which stops
  holding the moment platform compute is accounted for: such a run still
  occupies a sandbox the platform operates. The platform now reports the facts
  and the module applies its own policy — **including the decision that an
  operation consumes nothing**, which is no longer made on the module's behalf.
  A module that accounts only for platform-supplied inference reaches the same
  outcome as before by returning `null` when `credentialSource !== "system"`;
  one that also accounts for platform compute reads `executionPlane` and
  `timeoutSeconds`, with no change to this type and no change to where the hook
  fires. An operation that consumes neither a platform-supplied credential nor
  platform compute — `credentialSource !== "system"` and
  `executionPlane !== "platform"` — is the case to short-circuit first. Because
  the set of dispatched operations GROWS, this is breaking behaviourally even
  for a module whose code still type-checks: deploy modules before the platform.

- **`PlatformServices.checkUsageAllowed`** — no pre-filter, and one new required
  argument. The platform still resolves system-provided vs. organization-owned
  server-side (that is what keeps the chat module dumb — it has no
  model-registry access), but it now REPORTS the resolution as
  `credentialSource` instead of using it to decide whether to dispatch. A turn
  on the organization's own credential is dispatched all the same, because a
  chat turn always executes in the platform's own process.
  - **`subscription: boolean`** (BREAKING for callers) — the caller reports
    whether the turn runs on an OAuth provider subscription the organization
    authorized (claude-code, codex), driven by the in-process engine rather than
    the inference gateway. Such a turn is `credentialSource: "org"` whatever its
    preset resolves to. Subscription turns are no longer exempt: they DO call
    this now, because the platform funds the compute of a turn running inside
    its own process, and a module gating on subscription status must be able to
    refuse one.

- **The proxy seam gates every call, BYOK included.** `/api/llm-proxy` no longer
  short-circuits admission for a platform-origin run that declared a system
  credential, nor for a call that resolved to an organization-owned preset. A
  preflight quote is issued ONCE per run launch while the number of proxy calls
  attachable to that run id is unbounded, run attribution binds an API-key
  principal only to org + application (so any key of the application can stamp a
  live run's id onto its own calls), and once platform compute is billed the
  organization's balance moves DURING the run. A module therefore sees one
  dispatch per proxy call, carrying the resolved preset's `credentialSource`
  (`"system"` or `"org"`), the referenced run's `executionPlane`, and
  `timeoutSeconds: null`. Unchanged: the `usage_context_required` 400 applies
  only to platform-supplied calls, and a contextless BYOK call still succeeds —
  it dispatches nothing, since `BeforeUsageParams` cannot be built without a run
  or chat context. That gap is deliberate; closing it needs a context-less usage
  surface, not a filter.

- **`ModuleHooks` is split by dispatch mode.** `ModuleHooks` is now
  `FirstMatchHooks & BroadcastHooks`. Modules are unaffected (the declaration
  site, `hooks`, is still `Partial<ModuleHooks>`) but the platform's dispatchers
  now accept only their own half. Previously the mode was a property of the CALL
  SITE alone: `beforeSignup` is broadcast to every module, yet nothing in the
  types stopped a future `callHook("beforeSignup", …)` from silently skipping
  every signup gate but the first, nor a `callAllHooks("beforeUsage", …)` from
  discarding every rejection.

- **`ModulePermissionContribution` is now typed against `ModuleResources`.**
  It distributes over the augmentation, so `resource` pins the legal `actions`
  instead of both being `string`. A module contributing permissions MUST ship
  its `declare module "@appstrate/core/permissions"` block — without it the type
  resolves to `never`. Previously a typo produced a permission that type-checked
  at the guard site but was never granted at boot: a permanent 403 with no
  failing check anywhere.

- **`LlmUsageLedgerRow.source`** is `"proxy" | "runner"` instead of `string` —
  the same column was two different types in the same file, so a cursor consumer
  lost exhaustiveness. Its documentation also now states that `"proxy"` covers
  the in-process chat engine, which never traverses the proxy (distinguish a
  chat turn by `contextType`, never by `source`).

- **`SubscriptionChatModel.apiShape` / `ChatUsageRecord.apiShape`** are
  `ModelApiShape` instead of `string`, and both `cost` fields are `ModelCost`
  instead of a re-inlined structural copy whose JSDoc already claimed to be that
  type.

- **`RUNTIME_TOOL_CATALOG` no longer lists `report`; `SELECTABLE_RUNTIME_TOOLS`
  gains `publish_document`.** `report` stays selectable at the manifest/runtime
  boundary but is hidden from the editor — new agents publish `report.md` as a
  document. `SELECTABLE_RUNTIME_TOOLS` is now composed from the new
  `EVENT_EMITTER_RUNTIME_TOOLS` (`EventEmitterRuntimeTool`), which is the subset
  `buildRuntimeToolDefs` can construct standalone. `schema/agent.schema.json`
  accepts `publish_document` in `runtime_tools`.

- **`BeforeUsageParams` (`context: "run"`) — `runningCount` semantics.** It is
  now the PROJECTED in-flight count INCLUDING the run being admitted, so a
  concurrency-aware gate no longer treats the first run as zero cost. Type
  unchanged; a module's arithmetic must be reviewed.

### Removed (BREAKING)

Both removals are extension points with **zero implementers** across oss +
`packages/module-*` + cloud. `scripts/verify-module-contract.ts` now audits hook
and event names individually (not just the `hooks`/`events` contract members),
so a re-added name with no owner fails the check instead of surviving a release.

- **`ModuleHooks.afterRun` removed.** The post-run metadata patch (`(params:
RunStatusChangeParams) => Promise<Record<string, unknown> | null>`, whose
  result was persisted to `runs.metadata`). Its last consumer moved to sweeping
  the `llm_usage` ledger by cursor. `RunStatusChangeParams` is unchanged and
  still carries the same terminal payload — a module that needs the terminal
  fact listens to `onRunStatusChange`, which now fires with exactly the params
  `afterRun` received. The one capability lost is writing to `runs.metadata`;
  nothing used it.

- **`ModuleEvents.onUsageRecorded` + `UsageRecordedParams` removed.** The
  per-row ledger broadcast was emitted on every `llm_usage` write and listened
  to by nobody, while documenting a subtle contract (a `source:"runner"` row is
  cumulative and re-fires under one stable id, so consumers had to
  replace-by-id and never sum). The ledger is a PULL surface:
  `PlatformServices.usage.list` / `usage.settledFrontier` sweep it by serial-`id`
  cursor, which is what a consumer that must not miss spend had to use anyway.

### Changed (documentation)

- **`PlatformServices.usage.list` — row invisibility is now documented.** The
  service hides the runner's cumulative mirror row of a proxy-metered run, so
  returned ids are not contiguous and a consumer must not re-apply the rule.
  Behaviour unchanged; see the member's JSDoc for the full cursor contract.

- **License neutrality in the published contract.** The Apache-2.0 module
  contract named the proprietary `cloud` module six times in JSDoc and used
  "Billing-neutral" / "plan/quota" / "over-quota" vocabulary. Identifiers were
  already neutral; the comments now are too.

## [4.0.0] — 2026-07-21

> **Release ordering.** This release bumps `@appstrate/afps-shared` to
> `^0.3.0` (new `api-tool-naming` / `mcp-naming` subpaths). Publish
> `afps-shared@0.3.0` to npm (tag `afps-shared@0.3.0`) **before** tagging the
> next `core@` release, or `npm install @appstrate/core` will fail to resolve
> the range for registry/cloud/portal.

Collapses the multi-engine execution model onto the single Pi engine
(`@mariozechner/pi-coding-agent`). API-key and OAuth subscription runs (Claude
Pro/Max, ChatGPT Codex) all execute on Pi, whose SDK (`@mariozechner/pi-ai`)
emits each provider's subscription request fingerprint natively — the platform
forges nothing. Removes the provider→execution-engine binding contract in favour
of a provider-neutral bearer-swap.

### Added

- **`ModuleInitContext.getOrgName?`** — optional query helper resolving an
  organization's display name (`(orgId) => Promise<string | null>`, null when
  the org no longer exists). Lets modules label org-scoped outbound messages
  (e.g. transactional emails) with the organization concerned. Optional so
  modules degrade gracefully on older platforms that don't inject it.

- **`api_upload` is a first-class catalog member (#881)** —
  `resolveIntegrationToolCatalog` now appends the `api_upload` companion after
  each `api_call` whose auth declares `_meta["dev.appstrate/api"].auths.<key>
.upload_protocols`, matching the tool the sidecar already advertises at
  runtime. New exports: `API_UPLOAD_TOOL_NAME`, `apiUploadToolNameFor()`,
  `isApiUploadToolName()`. `ApiCallConfig` gains
  an optional `uploadToolName`, present iff `uploadProtocols` is non-empty.
  Previously the catalog listed only `api_call`, so
  `validateAgentIntegrationScopes` rejected an agent that selected `api_upload`
  with `unknown_tool` even though the runtime served it.

- **`@appstrate/core/oauth-bearer-swap`** — `applyOauthBearerSwap(headers,
accessToken)`, the sidecar `/llm` oauth branch's only header policy. Forces the
  real subscription bearer onto `authorization`, drops any `x-api-key`, and
  forwards every other header verbatim. Provider-neutral — it touches no
  provider-specific header, so the Pi SDK's own request fingerprint (user-agent,
  `anthropic-beta`, `chatgpt-account-id`, …) rides through unchanged. Pure (no
  credential lookup, no I/O); the caller owns SSRF + credential resolution.

- **Unified LLM usage metering contract.**
  - **`ModuleHooks.beforeUsage`** — one admission gate over metered LLM usage,
    replacing `beforeRun` (see Removed). `BeforeUsageParams` is a discriminated
    union: `{ context: "run"; packageId; runningCount }` and
    `{ context: "chat"; sessionId }` (both carry `orgId`). Same return contract
    as the old gate: `UsageRejection { code, message, status? }` to block, or
    null to allow. `RunRejection` is renamed to `UsageRejection`. _(Params
    widened in 5.0.0 with `credentialSource` / `executionPlane` /
    `timeoutSeconds`.)_
  - **`ModuleEvents.onUsageRecorded`** (`UsageRecordedParams`) — broadcast after
    each `llm_usage` ledger row is appended, carrying per-row attribution
    (source, principal, context, credential source, token counts, `costUsd`).
    Advisory; consumers that must not miss a row read the ledger by `id` cursor.
  - **`PlatformServices.usage`** — `list({ afterId?, limit?, credentialSource? })`
    and `settledFrontier()`: a serial-`id` cursor sweep of the append-only
    `llm_usage` ledger (returns `LlmUsageLedgerRow`, including the `settled` flag
    that marks when a runner row's growing cost is final). `settledFrontier()` is
    the safe cursor-init point at cutover — the highest id below which every row
    is settled (not a plain `MAX(id)`, which would strand an in-flight runner
    row's low, still-unsettled serial id below the watermark and drop its usage
    when it later settles). Replaces the runId-keyed `runs.listLlmUsage` (see
    Removed). Never projects `real_model` / `api`.
  - **`PlatformServices.checkUsageAllowed`** — chat-surface entry into
    `beforeUsage`; the platform decides system-provided vs. org-owned and only
    dispatches the hook for a system-provided model. _(Superseded in 5.0.0: the
    hook is dispatched for every turn and the resolution is reported as the
    `credentialSource` fact — this describes 4.0.0 behaviour, not current
    behaviour.)_
  - **`ChatUsageRecord.cost`** — the model's catalog per-token rates; the
    platform seam computes the equivalent USD via the shared `computeTokenCost`
    formula so the chat / proxy / runner producers can't drift.

### Fixed

- **`isValidToolName` accepts a digit-leading namespace.** The namespace token
  of a `{namespace}__{tool}` MCP name derives from a package id, and both
  `SLUG_PATTERN` and the AFPS name pattern allow a digit-leading scope
  (`@1password/connect`). The old pattern rejected such names, which made the
  sidecar's trusted registration path fail the whole integration — aborting
  the run — for any integration published under a digit-leading scope. The
  tool token keeps the stricter letter-leading alphabet.

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
- **`@appstrate/core/subprocess-env` removed.** The vendor-binary spawn helpers
  (`buildIsolatedSubprocessEnv`, `makeScopeResolver`, `BinaryResolver`) existed
  solely for the deleted Claude Agent SDK runner (`@appstrate/runner-claude` /
  `claude-binary.ts`); nothing spawns a vendor CLI on the single Pi engine and
  the subpath had zero importers left.

- **`ModuleHooks.beforeRun` removed** (with `BeforeRunParams` and `RunRejection`
  from `@appstrate/core/module`). Replaced by the unified `beforeUsage` hook
  (see Added) — no back-compat alias. A module gating runs moves its handler to
  `beforeUsage` and switches on `params.context === "run"`; the rejection type
  is now `UsageRejection`.
- **`PlatformServices.runs.listLlmUsage` removed** (the `runs` group is gone).
  The runId-keyed per-run ledger read is replaced by the generic serial-`id`
  cursor `PlatformServices.usage.list` (see Added), which spans run and chat
  attribution and exposes the `settled` flag a cursor consumer needs.

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

Imports move from the two predecessor packages onto `@appstrate/core` subpaths:
`@appstrate/validation` → `@appstrate/core/validation`, and `@appstrate/packages`
→ the matching subpath (`naming`, `dependencies`, `integrity`, `semver`,
`dist-tags`, `version-policy`, `system-packages`). There is no barrel export.
