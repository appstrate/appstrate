# Changelog

All notable changes to Appstrate will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Opt-in observability module (#847)** — OpenTelemetry moves out of core
  behind the `@appstrate/core/telemetry` façade into a workspace module
  `@appstrate/module-observability`. Core ships zero OTel footprint; add the
  module to `MODULES` and set `OTEL_ENABLED` to activate tracing/metrics.

### Fixed

- **Transparent egress for `delivery.env` integrations (#850, #779)** — the
  sidecar no longer drops egress for integrations that inject credentials via
  `delivery.env`; the per-run proxy path is applied transparently.
- **OIDC cross-context PKCE resume (#852)** — the end-user OAuth flow survives
  a cross-context resume (invite-signup state mismatch) instead of failing the
  PKCE exchange.
- **`PUT /api/models/:id` enforces the model-alias invariants (#875)** — the
  update route now runs the same alias checks as create on the effective
  post-update state (explicit label, body-`model` protocol, no
  oauth-subscription credential), closing a bypass where a row could be
  flipped to `aliased` — or re-pointed to an oauth credential — into a state
  creation rejects. The subscription chat resolver also fail-closes on a
  legacy aliased oauth row instead of executing its hidden binding.

### Security

- **Full-codebase security review remediation (#855, #863)** — 9 P0 + 15 P1 +
  12 systemic findings closed (SSRF `guarded-fetch` + bounded unzip hardening
  in `@appstrate/afps-shared`, among others), followed by a DRY/KISS/YAGNI
  audit-follow-up pass.

### CLI

- **Runner download progress + `runner uninstall` (#845)** — the CLI streams
  the daemon binary download with progress and adds a `runner uninstall`
  command.

### Documentation

- **Firecracker execution backend (#844)** — surfaced across the user-facing
  docs.

### Changed

- **Single Pi execution engine (#875)** — agent runs AND oauth-subscription
  chat (Claude Pro/Max via `claude-code`, ChatGPT via `codex`) all execute on
  the one Pi engine (`@mariozechner/pi-coding-agent`); the per-provider
  "official binary" run path and the Claude Agent SDK chat engine are removed.
  Pi's SDK emits each provider's subscription request shape natively — the
  platform forges nothing; the sidecar's oauth `/llm` mode is a pure
  bearer-swap (model aliases are rejected for oauth-subscription providers).
  Codex becomes chat-usable. The `#849` Claude-engine structured-output fix is
  superseded (that engine no longer exists; structured output flows through
  the Pi `output` runtime tool).
- CI action bumps: `docker/setup-buildx-action` 4.1.0→4.2.0 (#857),
  `actions/cache/restore` 4.2.4→6.1.0 (#858),
  `github/codeql-action/upload-sarif` 4.36.2→4.36.3 (#859),
  `actions/github-script` 7.0.1→9.0.0 (#861).

<!-- prior unreleased entries -->

### Added

- **Proxy-upload mode for S3 storage (#829)** — with `S3_PUBLIC_ENDPOINT`
  unset, upload URLs are now signed against `APP_URL`
  (`PUT /api/uploads/_content`) and the platform streams the body to the
  bucket server-side, so S3/MinIO can stay fully private (no published S3
  port, no second public FQDN). The installer's Docker-aware default tier
  moves from Tier 3 (bundled MinIO) to Tier 2 (filesystem storage) — MinIO
  adds no capability on a single node once serving is app-domain. The proxy
  sink now also binds the token's **exact declared size** (a completed body
  shorter than declared is rejected and rolled back, parity with the signed
  `Content-Length` of direct presign) and re-checks the **token expiry while
  the body streams** (a slow-trickled body can no longer hold the socket
  past the token window).

  **⚠ Behavior change for existing S3 deployments with `S3_PUBLIC_ENDPOINT`
  unset**: presigned URLs no longer fall back to `S3_ENDPOINT` — uploads
  route through `APP_URL` instead. Bytes now transit the platform (and your
  reverse proxy: check its body-size limit, see
  `examples/self-hosting/README.md` → Production Considerations), and
  `APP_URL` must be the instance's real public URL. To keep the previous
  direct-presign behavior, set `S3_PUBLIC_ENDPOINT` to your public S3
  endpoint. The platform warns at boot when proxy mode is active in
  production with a loopback `APP_URL`.

- **Inline file inputs on `runAgent` (#630)** — file-typed input fields now
  also accept RFC 2397 `data:<mime>;name=<filename>;base64,<payload>` URIs
  (≤4 MiB decoded) alongside `upload://` references. The bytes are written to
  the run workspace as a document with the same magic-byte MIME validation as
  staged uploads, and the payload is stripped from the persisted run input
  (compact `data:<mime>;name=<doc>;base64,` marker). JSON-only clients (MCP
  `invoke_operation`) can run an agent with a small file in a single call —
  no `createUpload` + signed PUT round-trips.

- **Unified memory surface (Letta-style `pin` / `note`, #273, ADR-011/012/013)** —
  `runs.state` + `package_memories` merged into a single `package_persistence`
  table with first-class `(actor_type, actor_id)` scope (`member` / `end_user`
  / `shared`). Two orthogonal attributes `(key, pinned)` collapse the previous
  `kind` enum into 3 quadrants (archive / pinned memo / pinned named slot).
  - System tools `@appstrate/note@1.0.0` (append archive) and
    `@appstrate/pin@1.0.0` (upsert named slot — `key="checkpoint"` is just
    one slot among `persona`, `goals`, `user_preferences`, …) replace the
    retired `@appstrate/add-memory` and `@appstrate/set-checkpoint`.
  - Always-on MCP tool `recall_memory` registered on the sidecar alongside
    `provider_call` / `run_history` / `llm_complete`.
  - REST API: `GET /api/agents/{scope}/{name}/persistence?kind=pinned|memory`
    plus targeted `DELETE` variants. Legacy `/memories` routes and the
    `memories:read|delete` permission are removed.
  - `RunResult.pinned: Record<string, PinnedSlot>` is the single wire-format
    surface; the temporary `RunResult.checkpoint` / `checkpointScope`
    top-level mirrors were dropped in #288.
  - Frontend: a single Memory tab on agent + run detail with two collapsibles
    (Pinned / Archive) and a scope filter (`All` / `Shared` / `Mine`).
- **AFPS Runtime extracted as `@appstrate/afps-runtime` (#227)** — portable,
  open-source bundle runner shipped as a workspace package (64 TS files):
  bundle loading + validation + SRI integrity, Ed25519 detached signing
  with trust-chain verification, conformance suite (L1–L4), event sinks
  (Console / File / HTTP / Composite) with Standard Webhooks HMAC and
  CloudEvents, Mustache rendering, credential providers (env / file /
  appstrate-backed), and a portable `afps` CLI (`run`, `test`, `sign`,
  `verify`, `keygen`, `inspect`, `render`).
  - New multi-package `.afps-bundle` format (`docs/architecture/BUNDLE_FORMAT_SPEC.md`):
    bundles an agent + its skills/tools/providers in a single artefact with
    Merkle-root integrity (per-file `RECORD` SRI → per-package SRI →
    bundle-level SRI on the canonical map). Endpoints:
    `GET /api/agents/:scope/:name/bundle` (export with `X-Bundle-Integrity`,
    `application/zip`) and `POST /api/packages/import-bundle` (accepts both
    `.afps-bundle` multi-package and legacy single-package `.afps`).
  - `apps/api/src/services/adapters/` shrinks ~1676 → ~1080 LOC (−35%) by
    delegating prompt assembly, stream parsing, lifecycle, reducer, runtime
    env contract, and signature policy to `@appstrate/afps-runtime`.
  - `tool-output@2.0.0` (breaking) — schema injected into `parameters.data`
    for constrained decoding, `replace-on-emit` semantics replace the prior
    deep-merge, run-level mismatch fails the run instead of warning.
- **Unified runtime protocol — single ingestion surface (#227 Parts 7–14)** —
  every run (platform container, remote CLI, GitHub Action) now POSTs
  HMAC-signed CloudEvents to `POST /api/runs/:runId/events` and
  `/events/finalize`. `AppstrateEventSink` is the sole writer.
  - DB migration 0006 — new columns on `runs` (`run_origin`,
    `sink_secret_encrypted`, `sink_expires_at`, `sink_closed_at`,
    `last_event_sequence`, `context_snapshot`) plus the new
    `credential_proxy_usage` table.
  - `POST /api/runs/remote` mints sink credentials (one-time secret,
    AES-256-GCM, 32-byte base64url); `PATCH /api/runs/:runId/sink/extend`
    refreshes the TTL.
  - LLM cost ledger renamed `llm_proxy_usage` → `llm_usage` with `source`
    enum (`proxy` | `runner`) and partial unique indexes per source.
    `aggregateRunCost` → `computeRunCost`; `finalizeRun` is the sole writer
    of `runs.cost`.
- **Runtime-pi on official MCP SDK (#281)** — agent tooling is **MCP-only**.
  Three canonical first-party tools (`provider_call`, `run_history`,
  `llm_complete`) replace the legacy `appstrate_<slug>_call` family. New
  `@appstrate/mcp-transport` workspace package adapts the MCP SDK to the
  AFPS tool format (`createMcpServer`, `createInProcessPair`,
  `createMcpHttpClient`).
  - Sidecar mounts `/mcp` (Streamable HTTP, stateless) alongside `/health`
    and `ALL /llm/*` (kept for in-container Pi SDK chat completion
    streaming). Tool descriptor poisoning hardening (Unicode strip,
    schema-property recursion) per CyberArk / Invariant Labs advisories.
  - Zero-knowledge enforcement: after MCP bootstrap, `runtime-pi` deletes
    `process.env.SIDECAR_URL` so even the bash extension cannot discover
    the sidecar. The legacy `/proxy` and `/run-history` HTTP routes are
    fully retired — runners 1.x are not compatible with this branch.
  - `SIDECAR_MAX_REQUEST_BODY_BYTES` (default 10 MB) and
    `SIDECAR_MAX_MCP_ENVELOPE_BYTES` (default 16 MB) configurable; loud-fail
    at boot on invalid values; structured 413 errors carry
    `{ reason, scope, limit, actual, envVar, hint }`.
- **Authorized devices for CLI (#269)** — full lifecycle for `cli_refresh_tokens`.
  - Phase 1: head-of-family metadata (`device_name`, `user_agent`,
    `created_ip`, `last_used_ip`, `last_used_at`) — UA / device_name never
    re-captured at refresh (immutability of identity).
  - Phase 2: cookie-only user-facing endpoints `/api/auth/cli/sessions`,
    `/sessions/revoke`, `/sessions/revoke-all` (backing
    `appstrate logout --all`) plus a Devices preferences page.
  - Phase 3: org-scoped admin routes
    `GET/DELETE /api/orgs/:orgId/cli-sessions[/:familyId]` gated by the new
    module-owned RBAC resource `cli-sessions: read | delete` (owner +
    admin grants). Audit-log reasons distinguish `user_revoked`,
    `user_revoked_all`, `org_admin_revoked`.
- **Channel-aware CLI install + self-update (#270, closes #249)** —
  build-time `__APPSTRATE_INSTALL_SOURCE__` stamp lets the CLI dispatch
  upgrades correctly per channel.
  - `appstrate self-update [--release X] [-f|--force]` — curl channel does
    in-place upgrade with minisign + SHA-256, bun channel hints toward
    `bun update -g`.
  - `appstrate doctor [--json]` — detects every `appstrate` on `$PATH`,
    dedupes by realpath, displays the channel each was stamped with.
    Hidden subcommand `__install-source` exposes a stable JSON contract
    (`{ version, source, schema: 1 }`).
  - Bootstrap script + Commander `preAction` hook warn on dual install,
    persist ack at `~/.config/appstrate/dual-install-ack.json` keyed on
    sorted realpaths (re-arms when the set changes).
  - Channel matrix and recipes in `docs/cli/upgrades.md`.
- **Connect — OAuth/credentials hardening (#279)** — three findings closed.
  - Symmetric revocation handling: shared `parseTokenErrorResponse`
    between `handleOAuthCallback` and `forceRefresh`, RFC 6749 §5.2
    `invalid_grant` classification, typed `OAuthCallbackError`.
  - Scope validation: `parseTokenResponse` returns `scopeShortfall`
    (granted ⊊ requested) and `scopeCreep` (granted ⊋ requested) — short-
    fall flags `needsReconnection`, creep is logged without blocking.
  - Versioned encryption envelope: credentials now stored as
    `v1:<kid>:<base64(iv|authTag|ciphertext)>` with multi-key keyring
    (`CONNECTION_ENCRYPTION_KEY_ID` + `CONNECTION_ENCRYPTION_KEYS`). Legacy
    v0 raw-base64 envelope is fully retired.
- **OpenAPI coverage holes closed (#285, closes #284)** — `GET /api/library`
  added, all 5 verbs on `/api/credential-proxy/proxy` documented, and
  `verify-openapi` gains a static Code ⊆ Spec analyser that parses
  `apps/api/src/index.ts` to enforce ADR-004 ("OpenAPI = source of truth").
- **API surface polish (#280)** — `x-mutually-exclusive` extension on
  cursor-paginated endpoints, SSE `id:` field per HTML SSE spec for
  `Last-Event-ID` resume, additive `RunError` shape (`code`, `context`,
  `timestamp`) aligned with JSON-RPC 2.0 §5.1, 5 new
  `CanonicalRunEvent` variants (`run.started`, `run.succeeded`,
  `run.failed`, `run.timedout`, `run.cancelled`), credential-proxy
  response headers documented (`X-Stream-Request`, `X-Run-Id`,
  `X-Truncated`, `X-Truncated-Size`).
- **Self-hosting closed mode (#228)** — env-driven invitation-only deployments.
  - `AUTH_DISABLE_SIGNUP=true` blocks new account creation; pending
    invitations and platform admins still pass through (resolves the
    Infisical-style "invitation breaks when signup is disabled" pitfall).
  - `AUTH_DISABLE_ORG_CREATION=true` restricts `POST /api/orgs` to
    platform admins; org-less users see a "Waiting for invitation" page.
  - `AUTH_PLATFORM_ADMIN_EMAILS` declarative allowlist (no UI, no
    migration, IaC-friendly).
  - `AUTH_ALLOWED_SIGNUP_DOMAINS` email-domain allowlist with invitation
    override for external contractors.
  - `AUTH_BOOTSTRAP_OWNER_EMAIL` (+ `AUTH_BOOTSTRAP_ORG_NAME`) auto-creates
    the root organization on first signup of the configured email.
  - `bun apps/api/scripts/bootstrap-org.ts --owner=… --name=…` for explicit
    ops bootstrap with idempotent JSON output.
  - `appstrate install` integration: interactive prompt asks for the
    bootstrap admin email (Tier ≥ 1, fresh installs only); non-interactive
    via `APPSTRATE_BOOTSTRAP_OWNER_EMAIL=… curl|bash` for IaC. When set,
    the closed-mode trio is written into the generated `.env`.
  - Post-install action note: when bootstrap is configured, the installer
    prints the exact `<APP_URL>/register` link the operator must open.
  - `RegisterPage` reads `AUTH_BOOTSTRAP_OWNER_EMAIL` from `__APP_CONFIG__`
    and pre-fills + locks the email field, plus a banner explaining why,
    so the operator only has to pick a password (typo-proof bootstrap).
  - After signup, the bootstrap owner is routed through the rest of
    onboarding (`/onboarding/create` auto-skips since the org already
    exists, landing on the model-config step) so they can configure
    their first model, providers, and invite teammates.
  - The display-name field is also pre-filled (still editable) by
    deriving a sensible name from the locked email
    (`john.doe@acme.com` → "John Doe"), so the operator only has to
    type a password to complete signup.
  - Full guide in `examples/self-hosting/AUTH_MODES.md`.
- Health check for main application container in Docker Compose
- Named Docker networks with data tier isolation (`appstrate-data`, `appstrate-public`)
- Shared `tsconfig.base.json` with strict settings across all packages
- `test` and `lint` tasks in Turborepo pipeline
- Root `bun test` script
- Explicit `exports` field in `@appstrate/connect` and `@appstrate/shared-types`
- RFC 9457 `errors[]` array populated on every 400 validation response so a
  single round-trip lists every problem (manifest, config, input, providers)
  instead of surfacing them one at a time.
- `POST /api/runs/inline/validate` runs preflight in `accumulate` mode,
  returning the full list of validation errors in one response.

### Fixed

- **Presigned upload URLs rejected plain PUTs (#630)** — `createUpload`'s
  signed S3 URL embedded a placeholder `x-amz-checksum-crc32=AAAAAA==`
  (AWS SDK ≥3.729 default checksum behaviour signing the empty presign body),
  so S3 refused the upload unless the client reverse-engineered the real
  base64 CRC32 header. Presigning now opts out of request-checksum
  calculation: a plain PUT with the returned headers works. Integrity is
  unchanged — size and magic-byte MIME are still enforced at consume. The
  `createUpload` / `runAgent` OpenAPI descriptions now document the full
  upload→run recipe (and the stale `multipart/form-data` body on `runAgent`
  was removed — the endpoint is JSON-only).

### Changed — AFPS 2.0 conformance pass (2026-05-26)

- **System-package manifests** migrated to AFPS 2.0.2 canonical vocabulary: 6 manifests renamed `tools` → `tools_policy` per §7.8 (`integration-clickup-mcp`, `integration-github-mcp`, `integration-gmail-mcp@2.0.0`, plus three local-test fixtures); 6 manifests migrated from `{{credential.<field>}}` to Arazzo-canonical `{$credential.<field>}` placeholder grammar per §7.6/§7.7 (`integration-freshdesk`, `-teamwork`, `-twilio`, `-woocommerce`, `-wordpress`, `-zendesk`).
- **Integration credential wire** (`/internal/integration-credentials/*`) dual-emits AFPS 2.0 canonical snake_case (`auth_key`, `auth_type`, `authorized_uris`, `scopes_granted`, `delivery_plans`, `expires_at_epoch_ms`, `header_name`, `header_prefix`, `allow_server_override`) alongside deprecated camelCase aliases for one release window.
- **`IntegrationSpawnSpec`** carries a `sourceKind: "local" | "remote" | "api"` peer discriminant (replaces the synthetic `server.type: "http"` sentinel that collided with AFPS `mcpServerTypeEnum`).
- **OpenAPI** `AgentDetail.dependencies` gained the `mcp_servers` group; `library.packages` gained the `mcp-server` group.
- **Frontend**: `mtls` (AFPS 2.0.1 §7.2) handled by `FieldsConnectModal` via new `client_cert` / `client_key` fallback + multi-line textarea heuristic for PEM paste + new i18n labels (fr/en).
- **`required_identity_claims`** (§7.4) now enforced in both `oauth2-strategy` and `login-strategy`; missing required claims abort the connection before persistence.
- **OAuth discovery** (`packages/connect/src/oauth-discovery.ts`) now projects `code_challenge_methods_supported` and `userinfo_endpoint` from the discovery document; precedence is manifest > discovery > default `["S256"]` for PKCE methods.
- **New `mcp-server` runtime image** `appstrate-mcp-runner-uv` for AFPS 2.0.2 / MCPB 0.4 `server.type: "uv"`.
- **`INTEGRATION.md`** content surfaced to the agent at runtime via the platform-prompt's `### API Documentation` subsection (§3.5).
- **Bundle metadata** `BundleMetadata` dropped the `x-${string}` index signature (AFPS 2.0 §10.1 removes `x-*` in favor of `_meta` reverse-DNS namespacing).

### Documentation

- New ADR-015 (AFPS 2.0 sidecar MCP surface) supersedes ADR-003 + ADR-014; banner warnings on ADR-007 + ADR-013.
- New `docs/architecture/AFPS_2_0_INTEGRATIONS.md` covers `auths` multi-method, `mtls`, OAuth discovery, `identity_claims`, `scope_catalog`+`implies`, `delivery.{http,env,files}`, `source.kind`, `tools_policy`+`hidden_tools`, `_meta`, Arazzo `connect.login`, migration from 1.x.
- `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/guides/writing-an-integration-with-connect.md` rewritten / updated for AFPS 2.0 vocabulary.

### Changed

- Pinned Docker images to specific versions (postgres:16.8, redis:7.4, minio RELEASE.2025-03-12)
- Main Dockerfile now runs as non-root `bun` user in production
- ESLint `no-unused-vars` upgraded from `warn` to `error`
- All workspace packages extend shared `tsconfig.base.json`
- Enabled TypeScript type-checking on `runtime-pi` (previously disabled via `noCheck: true`)
- **BREAKING (API contract)**: `parseBody` helper — used by ~80 call sites
  across ~22 route files (core routes + `webhooks` and `oidc` modules) — now
  emits `code: "validation_failed"` instead of `code: "invalid_request"` on
  body-validation failures, and populates `errors[]` with every Zod issue
  instead of setting the top-level `param` field on the first one. Clients
  that branch on `code === "invalid_request"` or read `body.param` for
  body-validation errors must be updated to handle
  `code === "validation_failed"` and read the per-field `errors[]` array.
  Non-body validation errors (auth, app context, rate limits) continue to
  use their existing codes unchanged.
- **BREAKING (API contract)**: `validateAgentReadiness` now emits
  `code: "invalid_config"` for config-schema failures instead of the legacy
  `config_incomplete`, aligning with the inline-preflight stage that already
  used `invalid_config`. The field name and message are unchanged. Clients
  branching on `code === "config_incomplete"` must be updated.
- `validateAgentDependencies` parallelises provider checks via `Promise.all`
  across `isProviderEnabled`, `getProviderCredentialId`, and
  `getConnectionStatus`. The pre-existing check-type precedence (enabled →
  profile → credential → status → scope) is preserved; within each check
  type, the thrown error still follows `providers` iteration order. Happy-
  path latency is reduced.
- `ValidationFieldError` entries now carry an optional `title` (human-
  readable). Throwing wrappers (`validateAgentReadiness`,
  `validateAgentDependencies`, inline-preflight fail-fast) use it so the
  `Problem.title` field keeps its historical wording (e.g. "Empty Prompt")
  instead of surfacing the machine code.

### Removed

- **Sidecar pre-warming pool** — empirical measurement after #406 (parallel
  agent+sidecar boot with MCP retry) showed the agent's own Bun cold start
  fully masks warm-image sidecar boot, so pre-warming bought no user-visible
  latency. Cold-pull protection (20–45 s on first run after deploy) is now
  handled by `DockerOrchestrator.initialize()` calling `ensureImage()` for
  both images at API boot. Removed: `apps/api/src/services/sidecar-pool.ts`
  (~280 LoC), `POST /configure` endpoint, `CONFIG_SECRET` auth, standby
  network (`appstrate-sidecar-pool`), replenish loop, `preConfigured` flag,
  `SIDECAR_POOL_SIZE` env var, and host-port bindings on the sidecar
  container (agents reach the sidecar via the `sidecar` DNS alias on the
  run network — no host port needed). Sidecars are now spawned per-run with
  all runtime config injected via env vars at container start.
- **Pre-prod legacy purge (#288)** — five surgical removals exploiting the
  absence of production data on this branch (net −312 LOC, 36 files):
  - v0 credential-encryption envelope (raw-base64 fallback) — only the v1
    versioned envelope remains.
  - `RunResult.checkpoint` / `checkpointScope` top-level mirrors —
    `RunResult.pinned: Record<string, PinnedSlot>` is the single surface.
    The DB column `runs.checkpoint` is preserved for the per-run snapshot
    consumed by the `run_history` MCP tool.
  - CLI `LEGACY_PROJECT_NAME` install fallback (#167 pre-fix shim).
  - `legacyHashRedirects` prop and its 4 consumers.
  - `normalizeProviderInitialState` legacy draft repair.
- **Architectural redundancies collapsed (#290)** — net −90 LOC across
  10 files, zero behaviour change: `enrichOneSchedule()` removed (single
  Promise.all path via `enrichSchedules`), `proxyLlmCall()` returns
  `Response` directly (drop `ProxyCallResult` indirection), package
  config is sourced exclusively from `CONFIG_BY_TYPE` (drop standalone
  `SKILL_CONFIG` / `TOOL_CONFIG` / `AGENT_CONFIG` / `PROVIDER_CONFIG` and
  duplicate `TYPE_TO_CONFIG`).
- **Modernization audit cleanup (#291)** — 5 findings.
- Legacy run reducer + `LoadedBundle` mono-package surface (#247) —
  hot-path resolvers (`ToolResolver` / `SkillResolver` / `ProviderResolver`)
  natively consume `Bundle` multi-package; one canonical digest API
  (`canonicalBundleDigest(bundle)`).
- Legacy `/proxy` and `/run-history` HTTP routes from the sidecar — agents
  reach those capabilities exclusively via MCP `tools/call` now (hard
  break, no soft-deprecation).
- Invalid `preserve-caught-error` ESLint rule

### Security

- Non-root container execution for main application image
- Network isolation between data services and public-facing services
- **Versioned credential encryption envelope (#279)** — credentials stored
  as `v1:<kid>:<base64(iv|authTag|ciphertext)>` with multi-key keyring
  enabling rotation windows (active key embeds the kid, retired keys held
  for decrypt-only). Legacy v0 envelope retired.
- **MCP tool descriptor poisoning hardening (#281)** — `sanitiseTextField`
  strips Unicode hidden characters (zero-width, RTL/bidi, BOM,
  Hangul/Khmer fillers, C0 controls); `sanitiseToolDescriptor` recurses
  through `inputSchema.properties` to mitigate Full-Schema Poisoning
  (CyberArk / Invariant Labs advisories). Limits enforced: tool desc
  ≤ 2048 B, param desc ≤ 512 B, schema ≤ 8192 B.
- **Pi image hardening (#227 Part 14)** — image size 877 MB → 313 MB
  (−64%); `unzip` apk dropped (fflate in-process), explicit UID/GID
  (`pi`=1001, sidecar `nobody:nobody`), `COPY --chown` instead of bulk
  recursive chown.
