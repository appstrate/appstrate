# AFPS Integrations — Runtime

Operational narrative for the integration runtime (env-delivery, container-per-integration, MITM credential injection, niveau-2 scope model, remote HTTP MCP). AFPS wire spec (canonical): <https://github.com/appstrate/afps-spec/blob/main/spec.md>.

### AFPS Integrations runtime (Phase 1.4, env-delivery + container-per-integration)

AFPS integrations with `source.kind: "local"` declare `source.server.{name, version}` pointing to an `mcp-server` package. The mcp-server's `server.type` (`node` | `python` | `binary` | `uv`, all MCPB-vocabulary values) and `server.entry_point` (snake_case per AFPS §3.4) determine the runtime image. The Bun runtime selection uses an MCPB-vocabulary `server.type: "node"` (since MCPB's `server.type` enum is `node|python|binary|uv` — no `bun`) + an Appstrate `_meta["dev.appstrate/mcp-server"].runtime: "bun"` override read by `integration-spawn-resolver` on the mcp-server manifest. The platform validates the agent's `dependencies.integrations[id]`, looks up the installed package + the per-application `integration_connections` row, decrypts the credential blob, and builds a `spawnEnv` from `manifest.auths.{key}.delivery.env` (`apps/api/src/services/integration-spawn-resolver.ts`). The resolved spawn plan is serialized into `INTEGRATIONS_TO_SPAWN_JSON` on the sidecar container's env at create time — the sidecar fetches each bundle via the internal `GET /internal/mcp-server-bundle/:scope/:name` endpoint (authenticated with the run token, dep + install double-check) so we don't fight Linux env-var size limits.

The sidecar's `integrations-boot.ts` then spawns one MCP server **per integration** in its own runner container:

```
sidecar (Bun, +docker-cli, /var/run/docker.sock mounted, runs as root only when integrations.length > 0)
  ├─ readIntegrationSpecsFromEnv()                  ← INTEGRATIONS_TO_SPAWN_JSON
  ├─ selectIntegrationRuntimeAdapter()              ← INTEGRATION_RUNTIME_ADAPTER (set by the launching
  │                                                    orchestrator to mirror RUN_ADAPTER; no auto-detection)
  ├─ adapter.prepare(runId)                         ← returns { listenerBindHost, proxyUrlFor(port) }
  │
  ├─ for each spec:
  │     ├─ fetchBundleBytes()                       ← platform /internal/mcp-server-bundle/...
  │     ├─ extractBundle() → /tmp/afps-integ-{ns}-XXX/  ← fflate unzip in-sidecar
  │     ├─ adapter.spawn({ runId, spec, bundleRoot, mitm })
  │     │     ── docker adapter ──
  │     │     RUNNER_IMAGE_BY_TYPE[server.type]:
  │     │       node   → appstrate-mcp-runner-node:latest    (75 MB)
  │     │       python → appstrate-mcp-runner-python:latest  (49 MB)
  │     │       binary → appstrate-mcp-runner-binary:latest  (11 MB)
  │     │     docker create --rm -i --cap-drop ALL --memory 256m --pids-limit 128 \
  │     │         --network appstrate-exec-<runId> -e <spawnEnv...> \
  │     │         --label appstrate.run=$RUN_ID --label appstrate.managed=true \
  │     │         <image> /bundle/<entry_point>
  │     │     docker cp /tmp/afps-integ-{ns}-XXX/. <id>:/bundle/
  │     │     docker cp <ca.pem> <id>:/tmp/appstrate-ca.pem      ← MITM only
  │     │     → SubprocessTransport(["docker","start","-ai",<id>])
  │     │     ── process adapter (dev / tests) ──
  │     │     HOST_INTERPRETER_BY_TYPE[server.type]:
  │     │       node → "node", python → "python3 -u", binary → exec entry directly
  │     │     → SubprocessTransport({ command, args, cwd, env: { ...spawnEnv, ...mitmEnv } })
  │     ├─ Client.connect → initialize → tools/list   ← MCP handshake
  │     └─ McpHost.register({ namespace, client })    ← tools exposed to the agent as {ns}__{tool}
  │
  └─ on shutdown: close MCP clients → adapter.shutdown() → close MITM listeners → unlink CA file
```

Key invariants:

- **Sidecar minimal by design**: no `node`, no `python`, no `bun` baked in. Adding a new language is one `runtime-pi/runners/<lang>/Dockerfile` + one entry in `RUNNER_IMAGE_BY_TYPE` (in `integration-runtime-adapter-docker.ts`) — the sidecar image (132 MB) doesn't grow.
- **Bun runtime via `_meta` (MCPB-vocabulary `server.type` preserved)**: MCPB's `server.type` enum is `node|python|binary|uv` — no `bun`. The mcp-server manifest is AFPS-native at the root with MCPB-vocabulary fields (`server` / `tools` / `user_config`) carried verbatim — NOT a strict-MCPB manifest (AFPS dropped that interoperability claim; a publish-time projection to strict-MCPB is reserved for a future minor, see AFPS §3.4 + §10.2). A bun-native server therefore keeps an MCPB-vocabulary `server.type: "node"` and declares the real runtime under `_meta["dev.appstrate/mcp-server"].runtime: "bun"`. `integration-spawn-resolver` reads the override (`getMcpServerRuntime` in `@appstrate/core/mcp-server`) and falls back to `server.type` when absent — so the effective runtime drives both `HOST_INTERPRETER_BY_TYPE["bun"]` (process mode, host subprocess, no Docker) and `RUNNER_IMAGE_BY_TYPE["bun"]` (docker mode, dedicated `appstrate-mcp-runner-bun` container with full cgroup/cap-drop/network isolation). The override lives on the mcp-server manifest only — the integration manifest carries auth/policy + the `source.server` reference, never server/runtime fields. There is deliberately NO in-process-bun-inside-the-docker-sidecar path: the sidecar runs as root with the Docker socket mounted when integrations are present, so running third-party bun code in its process tree would hand it root + socket → host-escape surface. Containerising bun in tier 3 keeps the security boundary intact.
- **Pluggable runtime adapter** (`integration-runtime-adapter.ts`): the sidecar's `bootIntegrations` is orchestrator-agnostic. `selectIntegrationRuntimeAdapter()` picks the adapter purely by `id` from `INTEGRATION_RUNTIME_ADAPTER` — **no availability probing / auto-detection**. The platform orchestrator that launches the sidecar sets it to mirror its own `RUN_ADAPTER` (`docker-orchestrator` → `docker`, `process-orchestrator` → `process`), so the integration runtime deterministically matches the run runtime and the sidecar never guesses its backend (an earlier `docker info` auto-probe selected Docker for a process-mode run whenever a daemon was reachable — removed). Each adapter owns: how to spawn the runner, what host the MITM listener should bind to (`listenerBindHost`), what URL the runner uses to reach it (`proxyUrlFor(port)`), where the CA cert lands inside the runtime, and how to tear down. Adding Firecracker is one new `integration-runtime-adapter-firecracker.ts` that calls `registerIntegrationRuntimeAdapter({ id, create })` plus teaching the orchestrators to emit that id — nothing in `integrations-boot.ts` changes. The var is also an operator override (both orchestrators honour a value already in the environment).
- **Docker socket gated by need**: `docker-orchestrator.createSidecar` only adds `binds: ["/var/run/docker.sock"]` + `user: "0:0"` when `spec.integrations.length > 0`. Runs without integrations keep the default `nobody:nobody` user with no socket.
- **Bundle delivery is HTTP, not env**: `INTEGRATIONS_TO_SPAWN_JSON` carries only manifest metadata + decrypted spawn env. Bundle bytes (potentially several MB) ship out-of-band via `GET /internal/mcp-server-bundle/:scope/:name`.
- **Auto-cleanup**: `docker create --rm` auto-removes the container when stdio closes; the docker adapter's `shutdown()` is the explicit-kill belt-and-suspenders path for misbehaving servers; orphan reaper sweeps anything missed by `appstrate.managed=true appstrate.run=<runId>`.
- **Process mode**: when the run is launched by `process-orchestrator` (`RUN_ADAPTER=process`, sidecar a host subprocess), it pins `INTEGRATION_RUNTIME_ADAPTER=process` and the process adapter spawns integrations via `Bun.spawn(["node"|"python3", entry])` against the host PATH — same MCP wire, no container isolation. Tests run in this mode (they set the var explicitly).
- **MCPB-vocabulary `server.type` preserved**: the `server.type` field uses the MCPB vocabulary exactly (`node|python|binary|uv`). The mcp-server manifest as a whole is AFPS-native, not strict-MCPB, so `.afps` bundles are NOT drop-in installable as `.mcpb` extensions in strict-MCPB hosts; a publish-time projection to a strict-MCPB bundle is reserved for a future AFPS minor (§3.4 + §10.2).
- **Tools surfaced to the LLM**: the sidecar's `McpHost` multiplexes spawned tools under a namespaced prefix (`{namespace}__{tool}`). The agent's `runtime-pi/mcp/direct.ts` discovers them via `tools/list` and registers one Pi extension per advertised non-first-party tool that forwards verbatim to `mcp.callTool`.
- **Boot is a hard gate — a declared integration that doesn't start aborts the run, every tier**: `bootIntegrations` no longer degrades silently. It records an `IntegrationBootReport` (`@appstrate/core/sidecar-types`) — `ok`, `declared`, `adapter`, `spawned[]`, `failed[]`, and an ordered, timed `breadcrumbs[]` trail (runtime adapter, MITM CA, per-integration `spawn Xms · connect Yms · ready` / `failed`). The sidecar serves it at `GET /integrations/boot-report` (no inbound auth — like `/mcp`; the agent container holds no run token, so the per-run network is the boundary — and it awaits the boot promise so the answer is final). After the MCP handshake the agent (`runtime-pi/entrypoint.ts`) fetches the report, relays every breadcrumb into `run_logs` as `appstrate.progress` events (`emitBootProgress` in `@appstrate/runner-pi`), and **`die()`s the run** (`failed`) when `ok` is false or the report can't be fetched within `BOOT_REPORT_DEADLINE_MS` (60 s). This replaces the old "missing python3 → empty toolset → LLM cheerfully says the integration isn't connected" silent-degradation failure mode. The agent also emits `bundle loaded` + `MCP connected` breadcrumbs of its own; `emitRuntimeReady`'s `runtime ready in Xms` stays the terminal line.

### AFPS Integrations MITM credential injection (Phase 1.5, `delivery.http`)

When an integration's `manifest.auths.{key}.delivery.http` declares a header (`api_key`, `oauth2`, `basic`, `mtls`, `custom` — see AFPS §7.2), Phase 1.5 routes its upstream HTTPS calls through a per-integration MITM proxy hosted **inside the sidecar**. The integration's MCP server never reads the credential — the proxy injects the configured header on the way out, refreshes the underlying OAuth2 token transparently when it nears expiry, and recovers from a mid-run `401` by force-refreshing and retrying once.

```
sidecar
  ├─ planCaBundle() + createOpensslCertGenerator()   ← per-run CA, openssl-backed
  ├─ createCertMinter({ caCert, caKey })             ← lazy per-SNI leaf certs
  ├─ for each integration with httpDeliveryAuths:
  │     ├─ GET /internal/integration-credentials/<id>           ← initial payload
  │     ├─ createIntegrationCredentialsSource()                  ← cache + refresh hook
  │     ├─ createIntegrationMitmListener() (binds 0.0.0.0 in Docker mode) ← per-SNI Bun.serve
  │     └─ docker create … --network appstrate-exec-<runId>     ← per-run bridge, DNS alias `sidecar`
  │             -e HTTPS_PROXY=http://sidecar:<port>
  │             -e NODE_EXTRA_CA_CERTS=/tmp/appstrate-ca.pem
  │             -e SSL_CERT_FILE / REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE
  │        docker cp <ca.pem> <id>:/tmp/appstrate-ca.pem
  │
  └─ on upstream 401:
        listener.refreshOnUnauthorized(authKey)
          → POST /internal/integration-credentials/<id>/refresh
          → swap in-cache payload, retry the upstream call once
```

Platform surface:

- `GET /internal/integration-credentials/{scope}/{name}` — live credentials + `HttpDeliveryPlan` per auth + `expires_at`. OAuth2 tokens refresh proactively when within `OAUTH_REFRESH_LEAD_MS` of expiry. Auth: same Bearer run-token as `/mcp-server-bundle`. Same dep-and-install guard so a leaked token can't enumerate credentials across the org.
- `POST /internal/integration-credentials/{scope}/{name}/refresh` — force-refresh every OAuth2 auth on this integration. `403` ↔ refresh-token revoked (connection flagged `needsReconnection`); sidecar translates to `401` for the integration.

Refresh helper: `apps/api/src/services/integration-token-refresh.ts:forceRefreshIntegrationConnection` mirrors `@appstrate/connect/token-refresh.forceRefresh` (which targets `user_provider_connections`) but writes back to `integration_connections`. Same `RefreshError` taxonomy (`revoked` vs `transient`); `invalid_grant` flips `needsReconnection`.

Key invariants:

- **Network model**: each run gets its own user-defined bridge network `appstrate-exec-<runId>` (created by the platform launcher, sidecar attached with alias `sidecar`). Runner containers join the same network and reach the MITM listener via Docker's embedded DNS (`http://sidecar:<port>`). The earlier attempt to share the sidecar's network namespace via `--network container:<id>` was abandoned because `docker start` raced against the daemon's short-id lookup on Docker Desktop, frequently leaving the runner stuck in `Created`. Process mode inherits the parent's NS — `127.0.0.1:<port>` reaches the listener directly.
- **Refresh storm protection**: per-`authKey` 5 s cooldown + in-flight dedup on `refreshOnUnauthorized` so a mis-scoped 401 (the credential is fine, the request itself is wrong) can't hammer the platform endpoint.
- **CA hygiene**: per-run CA, 1 h validity (matches max run duration), private key lives in memory on the sidecar — only the cert PEM (not the key) lands on local fs (`mode 0444`) for `docker cp`. Unlinked on `bootIntegrations().shutdown()`.
- **Graceful degradation**: if openssl is missing or CA bring-up fails, the sidecar logs `HTTP-delivery integrations will skip` and continues with env-delivery-only integrations. `delivery.env` integrations are unchanged from Phase 1.4 — credentials baked in at container create time.
- **`auths.{key}.delivery.http.allow_server_override`** (snake_case per AFPS §7.6): defaults to `false`. When the integration sets its own header of the same name as the injection target, the proxy strips it before forwarding (defence against integration code accidentally pre-empting the injection).
- **`delivery.http.encoding: "base64"`** (AFPS §7.6, opt-in): applied AFTER the `{$credential.*}` template expands but BEFORE `prefix` is prepended — the recipe for HTTP Basic auth (`{ prefix: "Basic ", value: "user:{$credential.api_key}", encoding: "base64" }` → `Authorization: Basic <b64('user:'+key)>`). In live use by several shipped system integrations (zendesk, twilio, woocommerce, freshdesk, wordpress, teamwork). Type: `ManifestDeliveryHttp.encoding?` (`integration-manifest-helpers.ts`).
- **Trust-store env block** (`buildMitmEnvBlock` in `integration-runtime-adapter.ts`): exports the per-run MITM CA path into four CA-bundle env vars so common HTTP clients trust it — `NODE_EXTRA_CA_CERTS` (Node/Bun fetch via undici), `SSL_CERT_FILE` (OpenSSL/libcurl), `REQUESTS_CA_BUNDLE` (Python requests/httpx), `CURL_CA_BUNDLE` (curl CLI) — plus the proxy vars pointing at the listener.
- **Operator observability** (`MitmListenerEvent`, `integration-mitm-listener.ts`): `request-forwarded` carries `{ url, status, authKey, retried }` (URL query string stripped — no `code=`/`token=` leak; header values are NEVER logged); `request-refused` carries `{ url, reason }` when `authorized_uris` didn't match; `upstream-error` fires when the fetch threw before any response (TLS/DNS). `request-forwarded` only emits once a response landed.
- **Dev reference fixture**: `@appstrate/mitm-test` (under `local-test-packages/`, not shipped) — a pure-stdlib Python MCP server with a `call_upstream` tool that fetches `https://api.test.appstrate.dev/<path>`. Its `api_key` auth declares `delivery.http` with `X-Mitm-Test-Token`. The integration never reads the API key — proves the injection happens entirely sidecar-side.
- **`delivery.http.encoding: "base64"`** (AFPS §7.6, opt-in): applied AFTER the `{$credential.*}` template expands but BEFORE `prefix` is prepended. Recipe for GitHub git smart-HTTP (which rejects `Authorization: Bearer` and requires HTTP Basic with `x-access-token` as the username): `{ prefix: "Basic ", value: "x-access-token:{$credential.access_token}", encoding: "base64" }` → `Authorization: Basic <b64('x-access-token:'+token)>`. Same integration keeps a separate Bearer header for REST (`delivery.http` is mutually exclusive with `delivery.env` per auth, but each auth has its own delivery block).
- **Trust-store env block** (`buildMitmEnvBlock` in `runtime-pi/sidecar/integration-runtime-adapter.ts`): exports five CA-bundle env vars + four proxy vars into the runner so the per-run MITM cert is trusted by every common HTTP client family. `NODE_EXTRA_CA_CERTS` (Node fetch + Bun fetch via undici), `SSL_CERT_FILE` (libcurl, OpenSSL), `REQUESTS_CA_BUNDLE` (Python requests), `CURL_CA_BUNDLE` (curl CLI), and `GIT_SSL_CAINFO` (git — it wraps libcurl but reads its own env var and IGNORES `CURL_CA_BUNDLE` / `SSL_CERT_FILE`, so the dedicated var is load-bearing for any git-shelling integration like `@appstrate/github-git-mcp`).
- **`process.env` inheritance gotcha**: integration code that shells out (e.g. `Bun.spawn`, `child_process.spawn`) MUST spread `process.env` into the child's `env` rather than passing a fresh object — `Bun.spawn({ env: {...} })` REPLACES the env, it does not merge. Dropping the proxy + CA vars silently bypasses the MITM listener and the request fails with `Could not resolve host` (sidecar's per-run network is `internal: true` so direct egress is blocked). Reference: the `runGit` helper in `scripts/system-packages/mcp-server-github-git-1.0.0/server/index.ts` was bitten by this and now does `env: { ...process.env, ...local }`.
- **Operator observability**: `MitmListenerEvent.kind === "request-forwarded"` carries `{ method, url, status, authKey, retried, headerInjected }`. URL has query string stripped (no `code=`/`token=` leaks). Header values are NEVER logged. Truth table for diagnosis: `headerInjected=true + 401` → upstream rejected (token revoked, wrong format, scope insufficient); `headerInjected=false + 401` → integration's `authorized_uris` didn't match the URL (request bypassed injection entirely). `kind === "upstream-error"` fires when the fetch itself threw before any response landed (TLS handshake, DNS, etc.) — `request-forwarded` only emits when a response was received.

### AFPS Integrations — scope model & tool selection (niveau 2)

Integration manifests model OAuth scopes via AFPS's snake_case vocabulary, exposing discrete MCP tools the agent can pick from. The manifest declares the catalog under `auths.{key}.scope_catalog` (§7.4); agents declare which tools they consume; the runtime infers the minimum scope set per (user, integration auth, account) as `∪(tools_policy.{name}.required_scopes for tools any installed agent uses)`.

Three enforcement layers (Phase 0/1/2/3 schema + validation + runtime):

Two additive manifest fields (validated by `packages/core/src/integration.ts`, per AFPS §7.4 + §7.8):

- `auths.{key}.scope_catalog: Array<{ value, label, description? }>` — catalog of OAuth scopes the upstream IdP exposes for this auth. Optional. When declared, `auths.{key}.scopes` defaults and `tools_policy.{name}.required_scopes` are validated as a subset; the IdP remains the ultimate authority at consent time.
- `tools_policy.{name}: { required_scopes? }` — sparse per-MCP-tool policy table (the AFPS `tools.{name}` block). `required_scopes` is a **per-auth map** `{ <auth_key>: string[] }`: it binds the scopes a tool needs to one or more declared `auths` entries and drives the agent-install scope union for OAuth consent. Each key MUST be a declared auth and its scopes ⊆ that auth's `scope_catalog`. Keying by auth is consent inference only — NOT an exclusivity lock: an auth absent from the map (e.g. a `pat` alongside a scoped `oauth`) still serves the tool, and the run/schedule connection picker uses `connectableAuthKeysForAgent`, which offers every declared auth. `hidden_tools: string[]` (§7.8) additionally suppresses tools from `tools/list` regardless of agent selection. (The former `scope_auth_key` field and the per-tool `url_patterns` MITM envelope were removed — `auths.{key}.authorized_uris` is the URL boundary.)

Agent-side, the integration **version** is a bare semver string on `dependencies.integrations.<id>` (§4.1, flat like skills and mcp_servers); the per-integration **configuration** (tool/scope/auth selection) lives in the separate top-level `integrations_configuration.<id>` map (§4.4):

```jsonc
{
  "dependencies": {
    "integrations": {
      "@appstrate/github-mcp": "^1.0.0",
    },
  },
  "integrations_configuration": {
    "@appstrate/github-mcp": {
      "tools": ["list_issues", "issue_write"],
      "scopes": ["user:email"],
    },
  },
}
```

A dependency with no configuration leaves no `integrations_configuration` entry — all three dependency maps are flat `{name: semver-range}`. The config's `tools[]` drives the sidecar's `McpHost.allowedTools` allowlist + OAuth scope inference; `scopes[]` is the escape hatch; `auth_key` (§4.4) disambiguates a multi-auth integration. Every `integrations_configuration` key MUST match a declared `dependencies.integrations` entry — the dep map is the canonical "is this integration declared" gate, and an orphan config key is rejected at manifest validation. `parseManifestIntegrations(manifest)` merges both into `{ id, version, tools?, scopes?, auth_key? }[]`; `writeManifestIntegrations` splits them back. These two functions in `@appstrate/core/dependencies` are the single read/write path.

**Least-privilege default**: `tools` undefined and `tools: []` are equivalent — 0 tools exposed at runtime, no auth connection required at run-kickoff. The agent author opts in per tool via the editor UI's checkboxes or the "Select all" button.

**AFPS §4.4 wildcard `tools: "*"`** (opt-in, AFPS §7.8): when the integration manifest declares `allow_undeclared_tools: true`, the agent MAY set `tools: "*"` to forgo per-tool selection and accept every tool the upstream MCP server advertises at runtime. The platform emits `IntegrationSpawnSpec.toolAllowlist === undefined` for this case, which the sidecar's `McpHost` interprets as "no allowlist" (legacy passthrough). Per-tool scope inference is bypassed; required OAuth scopes fall back to the selected auth's `default_scopes` (§7.4). The integration's `hidden_tools` filter still runs, and the spawn resolver additionally unions the `connect.tool` login primitive's name into `hiddenTools` under wildcard so the credential-acquisition tool is never exposed to the agent's LLM. Zero-trust preserved: the agent author cannot bypass the policy table unless the integration author explicitly authorized the pass-through.

- **Phase 1 (install-time, `apps/api/src/services/integration-scope-validation.ts`)** — `POST/PUT /api/packages/agents` + ZIP import refuse manifests whose `integrations_configuration[id].tools[]` selection includes an undeclared tool, or whose `scopes[]` selection escapes the `auths.{key}.scope_catalog` (per target auth). Field paths surface as `integrations_configuration.{id}.tools` / `integrations_configuration.{id}.scopes`. Configuration without a matching dep is rejected at manifest validation (the dep table is the canonical "is this integration declared" gate).
- **Phase 2 (OAuth connect, `apps/api/src/services/integration-scope-resolver.ts`)** — `POST /api/integrations/.../connect/oauth2` requests `defaults ∪ caller-supplied ∪ computeRequiredScopes(installed agents) ∪ getCurrentGrantedScopes(actor)`. Granted is unioned for **incremental consent**: re-consent never silently shrinks the granted set. `GET /api/integrations/.../auths/.../required-scopes` surfaces the breakdown for UI previews + "agent install needs an upgrade" detection.
- **Phase 3 (runtime, `runtime-pi/sidecar/mcp-host.ts` + `integrations-boot.ts`)** — `IntegrationSpawnSpec.toolAllowlist` (an array by default; the platform builds it from `integrations_configuration[id].tools`, defaulting to `[]` when the agent author didn't pick any tool — OR `undefined` for the AFPS §4.4 wildcard form `tools: "*"`) propagates to `McpHost.register({ allowedTools })`. The host filters `tools/list` so the agent's LLM only sees the tools the author selected; excluded tools (including anything in the integration's `hidden_tools`) emit a `tool_excluded_by_allowlist` audit log. Empty `[]` means the integration spawns (env-delivery / MITM credentials remain functional for side-channel use) but exposes nothing to the agent. `undefined` (wildcard) disables the allowlist filter so every upstream tool surfaces; the connect-login primitive is still hidden via `hiddenTools`.
- **Phase 4 (runtime MITM)** — _removed._ An earlier iteration enforced a per-tool URL envelope (`⋃ manifest.tools_policy[t].url_patterns` over the agent's `toolAllowlist`) in the sidecar MITM listener before credential injection. It shipped with zero adoption (no system integration declared `url_patterns`, and it only applied to local-runner integrations, of which none ship), so it was cut as speculative generality. The per-auth `auths.{key}.authorized_uris` allowlist (enforced in `integration-mitm-listener.ts` via `planMitmAction`) is the sole URL boundary.
- **Phase 5 (UI, `apps/web/src/pages/integration-detail.tsx` + `apps/web/src/components/package-detail/agent-integrations-block.tsx`)** — agent-install scope diffs are computed **client-side** via `requiredScopesForAgent` (`@appstrate/core/integration`) using the installed-agents snapshot already in the React Query cache, avoiding an extra round-trip. The Phase 2 server endpoint `GET /api/integrations/.../auths/.../required-scopes` remains the authoritative source for headless / API consumers and the OAuth kickoff union. Trade-off: client computation must stay in lockstep with `computeRequiredScopes` on the server — both call into the same `@appstrate/core/integration` helper to keep them aligned. The "Reconnect to grant" CTA reuses the existing OAuth kickoff path — Phase 2 already unions defaults + required + granted at the backend, so a single click triggers an incremental-consent flow (IdP shows the upgrade screen, previously-granted scopes are preserved). The panel is silent when no diff exists or when there's no connection yet (first-connect already requests the full union).
- **Phase 5b (agent editor, `apps/web/src/components/agent-editor/integration-tool-picker.tsx`)** — agent authors pick per-integration tools and OAuth scopes directly in the editor's Integrations section. The picker fetches the integration manifest via `useIntegrationDetail`, renders a checkbox grid for `manifest.tools_policy.*` (with each tool's `required_scopes` displayed for transparency) and another for `auths.*.scope_catalog`. Quick-action buttons `Select all` / `Select none` cover the common cases. When the integration declares `allow_undeclared_tools: true`, the picker also renders an "Include all upstream tools (advanced)" toggle that sets `entry.tools = "*"` and hides the per-tool checklist + api_call rows (scopes then come from `default_scopes`, see Phase 2 wildcard path). `ResourceEntry` carries optional `tools?: string[] | "*"` + `scopes?: string[]`; `setResourceEntries('integrations')` writes via `writeManifestIntegrations`, splitting the version into `dependencies.integrations[id]` and the tools/scopes into `integrations_configuration[id]`. The `"*"` literal round-trips verbatim — never spread as a string into `["*"]`.
- **Phase 6 (refresh-time scope-shrink, `apps/api/src/services/integration-token-refresh.ts` + `integration-credentials-resolver.ts`)** — when an OAuth refresh response echoes a `scope` field, `forceRefreshIntegrationConnection` overwrites the connection's `scopes_granted` column (OAuth 2 §5.1 authoritative grant) and returns `shrinkDetected: true` if the new set is strictly narrower than the previously-stored one. The resolver then calls `computeRequiredScopes` and flips `needsReconnection=true` when the shrink drops the actor below the union required by installed agents. Responses that omit `scope` entirely (the common case — OAuth 2 says "same as before") leave `scopes_granted` untouched. Fast-path: the agent scan only runs when the refresh actually shrank scopes, so the steady-state cost is one extra SELECT per refresh.

Phase 0 is schema-only. Phases 0-3 and 5-6 of the niveau 2 scope model are landed; Phase 4 (per-tool MITM URL envelope) was removed as speculative — `authorized_uris` is the URL boundary.

### AFPS Integrations — Phase 7: remote HTTP MCP support

Integrations declare `source.kind: "remote"` + `source.remote: { url: "https://…/mcp/v1", transport: "streamable-http" }` (or `transport: "sse"`) to be backed by a remote Streamable HTTP / SSE MCP server (e.g. Google's `gmailmcp.googleapis.com/mcp/v1`, Anthropic-hosted MCPs, Composio, Linear, …). The remote source has no bundle, no MITM listener, no CA cert. The sidecar opens a Streamable HTTP MCP client directly via `createMcpHttpClient` (`@appstrate/mcp-transport`) instead of spawning a runner container. Credentials flow: `integration-credentials-source` (cache + `refreshOnUnauthorized`) → custom `fetch` wrapper that reads the current `access_token` and injects `Authorization: Bearer <token>` per request, retrying once on 401 after a force-refresh. Implementation in `runtime-pi/sidecar/integrations-boot.ts:connectRemoteHttpIntegration`; spawn-side propagation in `apps/api/src/services/integration-spawn-resolver.ts` (drops `httpDeliveryAuths` for `isRemoteHttp`).

Trade-off vs. local stdio runners — defence-in-depth coverage:

| Niveau 2 phase             | stdio runner (Phase 1.4/1.5) | Remote HTTP MCP (Phase 7) |
| -------------------------- | ---------------------------- | ------------------------- |
| 1 — install validation     | ✅                           | ✅ (same path)            |
| 2 — OAuth scope union      | ✅                           | ✅ (same path)            |
| 3 — `tools/list` allowlist | ✅ McpHost filter            | ✅ McpHost filter         |
| 5/5b — UI                  | ✅                           | ✅ (same path)            |
| 6 — refresh-time shrink    | ✅                           | ✅ (same path)            |

Other deltas: no `.afps-bundle` signing surface, every tool call exits the perimeter (no air-gapped self-host), the per-call audit trail collapses from "raw upstream HTTP" to "MCP tool call". Operators pick per integration based on trust model — `source.kind: "remote"` is the right choice for managed/upstream-trusted MCPs; `source.kind: "local"` (with the referenced mcp-server's `server.type` being `node|python|binary|uv`) stays the right choice for sandboxed local execution where the MITM gives you a meaningful security boundary.

Reference integration: `@appstrate/gmail-mcp@2.0.0` (in `scripts/system-packages/integration-gmail-mcp-2.0.0/`) — Gmail backed by Google's official remote MCP. Same 10-tool catalog as Google's hosted server, with per-tool `tools_policy.{name}.required_scopes` driving the niveau 2 scope inference (gmail.readonly | compose | labels | modify spread across the catalog).

### AFPS Integrations — Phase 8: per-run shared workspace volume + MCP Roots

`mcp-server` packages may opt into a per-run shared workspace volume the agent can read/write. The motivating use case is the clone-edit-commit-push-PR loop in `@appstrate/github-git-mcp`: the server's `clone` tool writes to `/workspace/<repo>`, the agent's Pi runtime tools (`Read`/`Edit`/`Bash`) then mutate those files in place, and the server's `commit`/`push` tools read them back. Without a shared volume the agent and the server would see disjoint filesystems.

Opt-in surface (`mcp-server` manifest):

```jsonc
{
  "_meta": {
    "dev.appstrate/workspace": {
      "mount": "/workspace", // absolute POSIX; rejects `..`, control chars, root (`/`), kernel prefixes (`/proc`, `/sys`, `/dev`, `/etc`)
      "access": "rw", // "ro" (default) | "rw"
    },
  },
}
```

Parsed by `getMcpServerWorkspaceMount` (`@appstrate/core/mcp-server`); validation runs at install-time in `mcpServerManifestSchema.superRefine` so a malformed mount is rejected before publish. Validation rules: `mount` must be a non-empty string when present (a non-string is rejected, not silently coerced to the default), an absolute POSIX path, free of `..` traversal segments and control chars, and neither root (`/`) nor a kernel-managed prefix. `access` defaults to `"ro"` (least-privilege). Note the `ro`/`rw` mode is kernel-enforced only on the docker adapter (the `:ro` bind flag); on the process adapter (tier 0-2) it is advisory — there is no read-only bind for a host directory, so a server needing hard write-denial must run in docker mode.

End-to-end topology:

```
Platform launcher
  ├─ if any installed mcp-server opts in:
  │     ├─ tier 3 (docker): create named volume `appstrate-ws-<runId>` (label `appstrate.managed=true`)
  │     └─ tier 0-2 (process): create host tmpdir under `os.tmpdir()/appstrate-ws-<runId>/`
  ├─ build `WorkspaceHandle` (discriminated union on IsolationBoundary, `@appstrate/core/platform-types`)
  └─ propagate as `WORKSPACE_HANDLE_JSON` env into sidecar

Sidecar (integrations-boot)
  ├─ mount the same volume at `/workspace` on the agent container (`pi` user, UID 1001)
  ├─ for each opted-in mcp-server runner: bind `-v <vol>:<manifest.mount>[:ro]`
  │     + set `APPSTRATE_WORKSPACE=<manifest.mount>` for runtime convenience
  └─ MCP Roots: advertise `capabilities.roots.listChanged: false` to the runner; on
        `roots/list` return `[{ uri: "file://<mount>", name: "workspace", _meta: { ... access ... } }]`
```

**MCP Roots contract** (`runtime-pi/sidecar/integrations-boot.ts`): the sidecar IS the MCP Roots provider for spawned runners. `listChanged: false` because the root is fixed for the run lifetime — there's no UI surface to add/remove roots mid-run. Reference compatible servers: the modelcontextprotocol `filesystem` server and the cyanheads `git-mcp-server` both consume roots via this exact protocol.

**UID 1001 invariant** (cross-cuts security + workspace writes): the agent's `pi` user and ALL five runner images (`runtime-pi/runners/{bun,node,python,binary,uv}`) ship as UID 1001 / GID 1001. The init step that chowns the empty volume on first mount uses a marker file (Docker resets `uid:gid` on first mount of a fresh named volume to the daemon's defaults, typically root:root, which would 403 the agent). Adding a new runner image MUST keep this alignment or workspace writes silently fail with `Permission denied`. The github-git MCP server additionally prepends `-c safe.directory='*'` to every `git` invocation because git refuses to operate on a working tree whose uid differs from the EUID, even when the uid is correct — a defensive belt against ownership drift across image rebuilds.

**Cleanup**: `cleanupOrphanedVolumes()` mirrors the network reaper — runs at platform boot, removes any `appstrate-ws-*` volume whose corresponding run has terminated. Sidecar shutdown does NOT explicitly remove the volume (the platform owns the lifecycle), only the runner containers. Boundary creation (`DockerOrchestrator.createIsolationBoundary`) races the network + volume create via `Promise.allSettled` and tears down whichever side succeeded if the other rejects, so a partial create never orphans a resource ahead of the boot reaper.

**git ref/branch injection guard** (github-git server, `assertSafeRefArg`): every agent-supplied value that lands in a positional `git` argument (`clone.ref`, `checkout_branch.branch`/`base`, `push.branch`) is screened before the spawn. git treats a leading `-`/`+` as an option/force-refspec and `:` as a refspec separator, so an unguarded value (`ref: "-f"` → `git checkout -f` discards the working tree; `branch: ":main"` → `git push origin :main` deletes the remote branch) would reach git as a flag/refspec rather than a ref. Tools spawn git via an argv array (no shell), so this is purely git's own option/refspec parsing — not shell injection — but the blast radius (working-tree data loss, remote branch deletion) is real, hence reject-not-sanitise. Workspace-relative paths are independently floored by `resolveInWorkspace` (strip leading slash, reject `..`, re-assert the resolved path stays under the workspace root).

### AFPS Integrations — connection model

The connect lifecycle for integrations is **agent-driven** (not integration-driven), because OAuth scopes are inferred per-agent from `tools[]` selection. The integration detail page (`/integrations/:scope/:name`) is **admin-leaning**: activate/deactivate (non-destructive — installs/removes the `application_packages` row while FK'd connections survive), OAuth client (`integration_oauth_clients`) registration, read-only auth declarations + connection list, and a passive `RequiredScopesPanel` diff for audit. It does NOT surface user-facing connect/disconnect.

User-facing connect/upgrade lives on agent surfaces (`AgentConnectionsSection` + `MissingConnectionsModal` on the run-kickoff 412). Both render `<InlineConnectButton>` from `components/integration-connect/` which picks OAuth popup vs api_key/basic/custom fields modal based on `auth.type` and forwards the agent's per-tool scope inference (`tools_policy.{name}.required_scopes`) to the OAuth kickoff so consent asks for the minimum required.

**Multi-connection model**: a multi-auth manifest (e.g. GitHub MCP declaring `oauth` + `pat`) lets an actor hold N connections at once across any mix of declared auths. `saveIntegrationConnection` (`apps/api/src/services/integration-connections.ts`) deliberately has **no** single-auth gate — it just inserts. The runtime picks exactly one connection per run via the 5-layer resolver cascade (admin pin → run override → schedule override → member pin → fallback), and the member picker on the agent surface disambiguates when >1 candidate is accessible. Letting multiple shapes coexist matches real workflows (interactive OAuth in the UI + PAT for CI agents on the same integration).

**CI / automation pattern**: a single human who wants OAuth interactively _and_ a PAT for CI can either keep both connections on their own actor (the resolver/member-pick disambiguates), or isolate them via the headless actor model — create an end-user (`POST /api/end-users`), connect _its_ GitHub via PAT, run agents from CI via an API key with `Appstrate-User: eu_…` impersonation so the two never share a candidate set.
