# ADR-003: Sidecar Proxy for Credential Isolation

## Status

Accepted

## Context

Appstrate executes AI agent flows inside ephemeral Docker containers. These agents need to call external APIs (Gmail, ClickUp, etc.) using credentials that users have connected via OAuth or API keys. However, AI agents must never have direct access to raw credentials because:

- A compromised or misbehaving agent could exfiltrate tokens
- Credential rotation would require restarting running agents
- There is no way to enforce URI allowlists if the agent holds the credentials directly

The platform needs a mechanism to let agents make authenticated API calls without exposing secrets.

## Decision

Use a **separate sidecar container** that runs alongside each agent container on an isolated Docker network. The sidecar is a Hono service (`runtime-pi/sidecar/`) that exposes a single application-protocol endpoint, `/mcp` (Streamable HTTP MCP, stateless, per-request transport), plus a `/health` probe. Through `tools/call` on `/mcp`, the sidecar:

1. Looks up credentials from the platform via a signed execution token
2. Injects credentials into request headers (via `credentialHeaderName`/`credentialHeaderPrefix`)
3. Substitutes `{{variable}}` placeholders in headers, URL, proxy config, and optionally the request body (`substituteBody: true`)
4. Validates the target URL against the provider's `authorizedUris` allowlist
5. Forwards the request to the external API and returns the response as-is

The agent container has no `RUN_TOKEN`, no `PLATFORM_API_URL`, and no `ExtraHosts` entry -- it cannot reach the host machine or the platform API directly. All external communication goes through the sidecar.

**Agent-facing surface — MCP tools.** The agent invokes the sidecar through three canonical MCP tools: `provider_call({ providerId, method, target, headers?, body?, responseMode?, substituteBody? })` for credential-injecting outbound traffic, `run_history({ limit?, fields? })` for past-run metadata, and `recall_memory({ q?, limit? })` for archive memory lookup. `runtime-pi/extensions/mcp-direct.ts` registers them as Pi tools at boot using `dependencies.providers[]` from the bundle manifest to populate `provider_call.providerId`'s enum. Non-2xx upstream responses surface `isError: true` to the LLM. The sidecar's MCP `tools/call` handler delegates to the pure `executeProviderCall` helper in `runtime-pi/sidecar/credential-proxy.ts`. Credential isolation invariants (no `Authorization` on the wire, server-side injection only, `authorizedUris` enforcement, 401-with-refresh retry) are enforced inside that helper; the wire format is JSON-RPC over MCP end-to-end. The agent's primary completions are served by the `/llm/*` HTTP passthrough route described below — there is no MCP-side completion tool; sub-agent flows are handled by spawning a separate run via the platform API.

**Zero-knowledge enforcement.** Immediately after the MCP client connects in `runtime-pi/entrypoint.ts` and `MODEL_BASE_URL` has been wired into the Pi SDK, the bootloader runs `delete process.env.SIDECAR_URL`, so even the Pi bash extension cannot discover the sidecar's existence via `echo $SIDECAR_URL`. "Agent never sees the sidecar" is an enforced runtime invariant rather than a documentation convention.

**LLM completion path.** The Pi SDK in the agent container makes its own chat-completion HTTP calls to `${MODEL_BASE_URL}/v1/chat/completions` (or the equivalent provider-specific path). The platform wires `MODEL_BASE_URL = ${SIDECAR_URL}/llm`, so those calls land on the sidecar's `ALL /llm/*` route, which substitutes the per-run placeholder embedded in the SDK-generated headers for the real LLM API key and streams the upstream response back zero-copy. This route is intentionally HTTP, not MCP — the SDK consumes the LLM provider's native streaming protocol unchanged. The agent never holds the real key, and SSRF protection blocks `baseUrl` values pointing at private/metadata addresses.

Sidecars are spawned per-run (no pool). All runtime configuration (run token, platform URL, proxy URL, LLM config) is injected via environment variables at container start. To absorb cold-pull latency (20–45 s when the image is absent), `DockerOrchestrator.initialize()` calls `ensureImage()` on the PI and sidecar images at boot — this runs once per API process. After image pre-pull, fresh sidecar boot is fully masked by the agent's own Bun cold start when both containers are spawned in parallel (#406), so pre-warming added complexity without user-visible latency gains.

## Consequences

**Positive:**

- Zero-trust agent isolation: agents never see raw credentials (tokens, API keys, OAuth secrets)
- Credential rotation happens without restarting agents (sidecar fetches fresh credentials per request)
- URI allowlists enforced at the proxy layer, preventing agents from calling unauthorized endpoints
- Parallel sidecar+agent boot + agent's natural cold start mask sidecar startup; image pre-pull at API boot covers the cold-pull case
- Response pass-through preserves upstream HTTP status codes and content types
- Inline response cap (32 KB by default) keeps the agent's context window bounded — oversized or binary responses spill to the run-scoped `BlobStore` and surface as MCP `resource_link` blocks the agent reads on demand
- Typed `provider_call` tool surface (one tool, `providerId` enum) gives structured observability (`provider.called` events carry `providerId`, `method`, `target`, `status`, `durationMs`) instead of opaque bash calls, and shortens the system prompt to a single `## Connected Providers` section

**Negative:**

- Additional container per execution increases resource usage
- Adds network hop latency for every external API call
- Debugging credential issues requires inspecting both sidecar logs and agent logs

**Neutral:**

- Outbound proxy cascade: agent-supplied `proxyUrl` argument on `provider_call`, then `PROXY_URL` env var
- Sidecar shares the same Hono framework as the main platform, keeping the stack consistent
