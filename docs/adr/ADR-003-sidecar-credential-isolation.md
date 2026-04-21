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

Use a **separate sidecar container** that runs alongside each agent container on an isolated Docker network. The sidecar is a Hono HTTP proxy (`runtime-pi/sidecar/`) that:

1. Receives requests from the agent at `$SIDECAR_URL/proxy`
2. Looks up credentials from the platform via a signed execution token
3. Injects credentials into request headers (via `credentialHeaderName`/`credentialHeaderPrefix`)
4. Substitutes `{{variable}}` placeholders in headers, URL, proxy config, and optionally the request body (`X-Substitute-Body: true`)
5. Validates the target URL against the provider's `authorizedUris` allowlist
6. Forwards the request to the external API and returns the response as-is

The agent container has no `RUN_TOKEN`, no `PLATFORM_API_URL`, and no `ExtraHosts` entry -- it cannot reach the host machine or the platform API directly. All external communication goes through the sidecar.

**Agent-facing surface — AFPS `<provider>_call` tools (2026-04).** The agent no longer invokes the sidecar via `bash`/`curl`. At run start the runtime reads `dependencies.providers[]` from the bundle manifest and registers one typed tool per entry (`@appstrate/gmail` → `appstrate_gmail_call`, etc.) via `SidecarProviderResolver` from `@appstrate/afps-runtime/resolvers` and `buildProviderExtensionFactories` from `@appstrate/runner-pi`. The tool takes `{ method, target, headers?, body?, responseMode? }`, enforces `authorizedUris` client-side before dispatch, POSTs to `${SIDECAR_URL}/proxy` with the expected `X-Provider`/`X-Target` headers, and returns the upstream `{ status, headers, body }` as a single JSON text payload. Non-2xx upstream responses surface `isError: true` to the LLM. The sidecar HTTP contract is unchanged — this is a client-surface migration that unifies the container runtime and the `appstrate run` CLI (both now use the same bridge) and keeps the prompt ~2 KB shorter per run by dropping the former "Authenticated Provider API" curl tutorial.

A **sidecar pool** (`sidecar-pool.ts`) pre-warms containers at startup to avoid cold-start latency. Pool size is configurable via `SIDECAR_POOL_SIZE` (default: 2). Pooled sidecars are configured at acquisition time via `POST /configure`.

## Consequences

**Positive:**

- Zero-trust agent isolation: agents never see raw credentials (tokens, API keys, OAuth secrets)
- Credential rotation happens without restarting agents (sidecar fetches fresh credentials per request)
- URI allowlists enforced at the proxy layer, preventing agents from calling unauthorized endpoints
- Sidecar pool eliminates container startup latency for most runs
- Response pass-through preserves upstream HTTP status codes and content types
- Large responses are truncated (>50KB) with `X-Truncated: true` header to protect agent context windows
- Typed `<provider>_call` tool surface gives structured observability (`provider.called` events carry `providerId`, `method`, `target`, `status`, `durationMs`) instead of opaque bash calls, and shortens the system prompt by eliminating per-provider curl examples

**Negative:**

- Additional container per execution increases resource usage
- Adds network hop latency for every external API call
- Sidecar pool consumes memory even when no flows are running
- Debugging credential issues requires inspecting both sidecar logs and agent logs

**Neutral:**

- Proxy cascade supports multiple layers: agent `X-Proxy` header, then `PROXY_URL` env var
- Sidecar shares the same Hono framework as the main platform, keeping the stack consistent
