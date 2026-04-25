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

Use a **separate sidecar container** that runs alongside each agent container on an isolated Docker network. The sidecar is a Hono service (`runtime-pi/sidecar/`) that exposes a single application-protocol endpoint, `/mcp` (Streamable HTTP MCP, stateless, per-request transport), plus a `/health` probe and a one-shot `/configure` for sidecar-pool warm acquisitions. Through `tools/call` on `/mcp`, the sidecar:

1. Looks up credentials from the platform via a signed execution token
2. Injects credentials into request headers (via `credentialHeaderName`/`credentialHeaderPrefix`)
3. Substitutes `{{variable}}` placeholders in headers, URL, proxy config, and optionally the request body (`substituteBody: true`)
4. Validates the target URL against the provider's `authorizedUris` allowlist
5. Forwards the request to the external API and returns the response as-is

The agent container has no `RUN_TOKEN`, no `PLATFORM_API_URL`, and no `ExtraHosts` entry -- it cannot reach the host machine or the platform API directly. All external communication goes through the sidecar.

**Agent-facing surface — MCP `provider_call` tool (2026-04, MCP V2 cleanup).** The agent invokes the sidecar through three canonical MCP tools: `provider_call({ providerId, method, target, headers?, body?, responseMode?, substituteBody? })` for credential-injecting outbound traffic, `run_history({ limit?, fields? })` for past-run metadata, and `llm_complete(...)` for platform-configured LLM passthrough. `runtime-pi/extensions/mcp-direct.ts` registers them as Pi tools at boot using `dependencies.providers[]` from the bundle manifest to populate `provider_call.providerId`'s enum. Non-2xx upstream responses surface `isError: true` to the LLM. The sidecar's MCP `tools/call` handler delegates to the pure `executeProviderCall` helper in `runtime-pi/sidecar/credential-proxy.ts` — the same helper that backed the historical HTTP `/proxy` route before it was retired. Credential isolation invariants (no `Authorization` on the wire, server-side injection only, `authorizedUris` enforcement, 401-with-refresh retry) are unchanged; only the wire format moved from bespoke HTTP to JSON-RPC over MCP.

**Zero-knowledge enforcement (2026-04).** Immediately after the MCP client connects in `runtime-pi/entrypoint.ts`, the bootloader runs `delete process.env.SIDECAR_URL`, so even the Pi bash extension cannot discover the sidecar's existence via `echo $SIDECAR_URL`. The historical `curl "$SIDECAR_URL/…"` bash pattern is fully retired — no prompt path documents it anymore. "Agent never sees the sidecar" is an enforced runtime invariant rather than a documentation convention.

A **sidecar pool** (`sidecar-pool.ts`) pre-warms containers at startup to avoid cold-start latency. Pool size is configurable via `SIDECAR_POOL_SIZE` (default: 2). Pooled sidecars are configured at acquisition time via `POST /configure`.

## Consequences

**Positive:**

- Zero-trust agent isolation: agents never see raw credentials (tokens, API keys, OAuth secrets)
- Credential rotation happens without restarting agents (sidecar fetches fresh credentials per request)
- URI allowlists enforced at the proxy layer, preventing agents from calling unauthorized endpoints
- Sidecar pool eliminates container startup latency for most runs
- Response pass-through preserves upstream HTTP status codes and content types
- Large responses are truncated (>50KB) with `X-Truncated: true` header to protect agent context windows
- Typed `provider_call` tool surface (one tool, `providerId` enum) gives structured observability (`provider.called` events carry `providerId`, `method`, `target`, `status`, `durationMs`) instead of opaque bash calls, and shortens the system prompt to a single `## Connected Providers` section

**Negative:**

- Additional container per execution increases resource usage
- Adds network hop latency for every external API call
- Sidecar pool consumes memory even when no flows are running
- Debugging credential issues requires inspecting both sidecar logs and agent logs

**Neutral:**

- Proxy cascade supports multiple layers: agent `X-Proxy` header, then `PROXY_URL` env var
- Sidecar shares the same Hono framework as the main platform, keeping the stack consistent
