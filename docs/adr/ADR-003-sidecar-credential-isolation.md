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

The agent container has no `EXECUTION_TOKEN`, no `PLATFORM_API_URL`, and no `ExtraHosts` entry -- it cannot reach the host machine or the platform API directly. All external communication goes through the sidecar.

A **sidecar pool** (`sidecar-pool.ts`) pre-warms containers at startup to avoid cold-start latency. Pool size is configurable via `SIDECAR_POOL_SIZE` (default: 2). Pooled sidecars are configured at acquisition time via `POST /configure`.

## Consequences

**Positive:**

- Zero-trust agent isolation: agents never see raw credentials (tokens, API keys, OAuth secrets)
- Credential rotation happens without restarting agents (sidecar fetches fresh credentials per request)
- URI allowlists enforced at the proxy layer, preventing agents from calling unauthorized endpoints
- Sidecar pool eliminates container startup latency for most executions
- Response pass-through preserves upstream HTTP status codes and content types
- Large responses are truncated (>50KB) with `X-Truncated: true` header to protect agent context windows

**Negative:**

- Additional container per execution increases resource usage
- Adds network hop latency for every external API call
- Sidecar pool consumes memory even when no flows are running
- Debugging credential issues requires inspecting both sidecar logs and agent logs

**Neutral:**

- Proxy cascade supports multiple layers: agent `X-Proxy` header, then `PROXY_URL` env var
- Sidecar shares the same Hono framework as the main platform, keeping the stack consistent
