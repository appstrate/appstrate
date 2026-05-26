# ADR-015: AFPS 2.0 — `{ns}__api_call` / `{ns}__api_upload` replace `provider_call`

**Status**: Accepted
**Date**: 2026-05-26
**Supersedes**: ADR-003, ADR-014
**Related**: ADR-007 (npm-style naming — AFPS 2.0 retypes the package taxonomy), ADR-013 (built-in runtime tools — note/pin/log/report/output are now in-process, no longer AFPS packages)

## Context

AFPS 2.0 replaced the 1.x package taxonomy. The 1.x `provider` package type — a credential definition with a fixed `definition.authorizedUris` + `definition.credentialHeaderName` triple, consumed via `dependencies.providers[]` — became the AFPS 2.0 **`integration`** type, which carries a multi-method `auths` map (`{ key -> { type, delivery, authorized_uris, available_scopes?, … } }`) and a `source.kind: "local" | "remote" | "api"` field selecting the runtime model (containerised MCP runner, remote HTTP MCP, or pure credential proxy). In parallel, the 1.x `tool` package type became `mcp-server`, with verbatim MCPB-shaped manifests.

This taxonomy change broke the agent-facing surface previously documented in:

- **ADR-003** — described a fixed `provider_call({ providerId, method, target, headers?, body?, responseMode?, substituteBody? })` MCP tool, keyed on the bundle's `dependencies.providers[]` enum, with URL validation against the provider's `definition.authorizedUris`.
- **ADR-014** — described `provider_upload({ providerId, uploadProtocol, … })`, gated by the provider's `definition.uploadProtocols: string[]`, dispatching chunked PUTs through the same `provider_call` tool.

Both ADRs assumed:

1. A single global `provider_call` tool with a `providerId` enum.
2. URL validation per-provider (`definition.authorizedUris`).
3. Credential injection driven by `definition.credentialHeaderName` / `credentialHeaderPrefix`.
4. The agent-side `dependencies.providers[]` array as the source of truth for what credentials exist.

None of these primitives exist in AFPS 2.0. Integrations declare credentials per-auth-method (`auths.<key>`); a single integration can expose multiple auths (`oauth2` + `pat`, etc.); URL allowlists are per-auth (`authorized_uris`); credential header injection is described declaratively via `auths.<key>.delivery.http` (with Arazzo `{$credential.<field>}` value-template grammar). The sidecar's tool surface therefore had to be reshaped per-integration, not global.

## Decision

Per spawned integration (see "AFPS Integrations runtime" in `CLAUDE.md`), the sidecar's `McpHost` exposes:

- **`{ns}__api_call({ method, target, headers?, body?, responseMode? })`** — outbound credential-injecting proxy. The credential is selected by the integration's currently-resolved `auths.<key>` (multi-connection model — see below), injected server-side per `auths.<key>.delivery.http` using the Arazzo `{$credential.<field>}` value-template grammar. URLs are validated against `auths.<key>.authorized_uris` (snake_case in the AFPS 2.0 manifest; the 1.x `authorizedUris` camelCase carve-out is gone).
- **`{ns}__api_upload({ method?, target, file, uploadProtocol?, headers?, partSizeBytes? })`** — chunked resumable upload, exposed only when the integration declares `source.api.upload_protocols?: string[]`. The agent-side resolver picks the right upload adapter (`google-resumable`, `s3-multipart`, `tus`, `ms-resumable`, custom) and orchestrates chunked dispatch through `{ns}__api_call`. The sidecar is unchanged from ADR-014's chunked model — only the dispatcher tool name changed.
- **Any additional MCP tools the integration's spawned server advertises** — discovered via the runner's `tools/list`, surfaced under the same `{ns}__{tool}` namespace, gated by the agent's per-tool allowlist (`integrations[id].tools`, ADR — niveau 2 scope model, Phase 3).

First-party tools (`run_history`, `recall_memory`) remain unchanged — they are not per-integration and keep their canonical names.

### Namespace derivation

`{ns}` is taken from the agent's `dependencies.integrations[id]` keys (post-AFPS-2.0 — `integrations`, not `providers`). The namespacing prefix is computed deterministically by `McpHost.register({ namespace, … })` so the same package installed twice under different ids would not collide (though in practice the bundle's id is unique).

### Credential delivery and URL allowlists

The injection contract is fully declarative:

- `auths.<key>.delivery.http.header` — header name.
- `auths.<key>.delivery.http.value` — value template using Arazzo's `{$credential.<field>}` grammar (e.g. `"Bearer {$credential.access_token}"`).
- `auths.<key>.authorized_uris` — per-auth-method URL allowlist (snake_case wire field).
- `auths.<key>.available_scopes` (optional, OAuth2 only) — drives the niveau 2 scope-inference model.

For `delivery: { kind: "http" }`, credentials are injected by the MITM listener inside the sidecar (Phase 1.5). For `delivery: { kind: "env" }`, credentials are baked into the runner container's environment at create time (Phase 1.4). For `source.kind: "remote"` HTTP MCP, the sidecar's Streamable HTTP MCP client wraps `fetch` to inject `Authorization: Bearer <token>` per request (Phase 7).

### Multi-connection resolution

A single actor can hold multiple connections per `(actor, integration, auth_key)` (e.g. GitHub `oauth2` + `pat` simultaneously). The 5-layer resolver cascade (`apps/api/src/services/integration-spawn-resolver.ts`) picks exactly one connection per run: admin pin → run override (`connection_overrides`) → schedule override → member pin → fallback. This replaces ADR-003's implicit "one connection per provider" model.

## Consequences

### Behavioural

- **Agent authors writing against AFPS 2.0** must use `{ns}__api_call` / `{ns}__api_upload`, not `provider_call`. The LLM-facing tool catalogue is constructed per-run from the agent's resolved integrations; there is no global `provider_call` anymore.
- **Prompts written against AFPS 1.x** referring to `provider_call({ providerId: "@scope/name", … })` must be rewritten before they can be re-run against AFPS 2.0. The 1.x system packages and the corresponding sidecar handler were removed — there is no compat alias.
- **System prompt `## Connected Providers` section** (ADR-003 positive consequence) is replaced by a per-integration tool advertisement: the LLM sees one namespaced toolset per integration, with each tool's description self-documenting credential injection and URL allowlist enforcement.

### Operational

- **URL validation surface** is now per-integration-per-auth-method (`auths.<key>.authorized_uris`), not per-provider (`definition.authorizedUris`). A single integration with `oauth2` + `pat` can declare different allowlists per auth — useful when (e.g.) a PAT is scoped to a narrower API surface than an OAuth token.
- **Casing**: the AFPS 1.x carve-out for camelCase manifest fields (`authorizedUris`, `credentialHeaderName`, `uploadProtocols`) is gone. AFPS 2.0 manifests use snake_case on the wire (`authorized_uris`, `upload_protocols`, `available_scopes`). The TS schema (`@appstrate/core/integration`) re-maps to camelCase for internal use per the universal casing convention.
- **Upload session leak window** (ADR-014's "operational consequence" — best-effort `adapter.abort()` on hard crash) is unchanged. Self-hosted operators running against S3 still need a bucket-side `AbortIncompleteMultipartUpload` lifecycle rule.

### Architectural invariants preserved

- **Zero-knowledge enforcement** (ADR-003): `delete process.env.SIDECAR_URL` after MCP handshake — unchanged. The agent never sees the sidecar URL.
- **Credential isolation** (ADR-003): credentials never reach the agent's process. Injection happens inside the sidecar (env-delivery) or via the MITM listener (http-delivery) or via the sidecar's `fetch` wrapper (remote-HTTP-MCP delivery).
- **Workspace isolation** (ADR-014): the sidecar still has no workspace mount. `{ns}__api_upload` still streams chunks from the agent container via `Bun.file().stream()` and dispatches them through `{ns}__api_call`.

## Implementation pointers

- Sidecar boot + per-integration spawn: `runtime-pi/sidecar/integrations-boot.ts`
- MCP host (per-integration namespacing + per-tool allowlist): `runtime-pi/sidecar/mcp-host.ts`
- Credential resolver / OAuth token refresh: `apps/api/src/services/integration-credentials-resolver.ts`, `apps/api/src/services/integration-token-refresh.ts`
- Upload adapters (Google resumable, S3 multipart, tus, MS Graph): `runtime-pi/mcp/upload-adapters/`
- Spawn-spec resolver (5-layer connection cascade, `INTEGRATIONS_TO_SPAWN_JSON` builder): `apps/api/src/services/integration-spawn-resolver.ts`
- Integration manifest validation (snake_case wire shape): `packages/core/src/integration.ts`
- MITM listener (http-delivery credential injection): `runtime-pi/sidecar/integration-mitm-listener.ts`
- Remote HTTP MCP client (Phase 7): `runtime-pi/sidecar/integrations-boot.ts:connectRemoteHttpIntegration`

## References

- ADR-003 — sidecar credential isolation (superseded; describes the retired `provider_call` global tool).
- ADR-014 — `provider_upload` chunked resumable uploads (superseded; the chunked dispatch model survives, but the tool name and gating manifest field changed).
- ADR-007 — npm-style naming (the package-type enumeration drifted with AFPS 2.0: `tool → mcp-server`, `provider → integration`).
- ADR-013 — Letta-style `pin` / `note` (the migration-mention text drifts in places; the tools themselves are now built-in runtime tools, not AFPS packages).
- AFPS 2.0 spec (`afps-spec/`) — full schema definition of `integration`, `mcp-server`, and the `auths.*.delivery` grammar.
- CLAUDE.md "AFPS Integrations runtime" + "AFPS Integrations MITM credential injection" + "AFPS Integrations — scope model & tool selection" + "AFPS Integrations — Phase 7: remote HTTP MCP support" sections.
