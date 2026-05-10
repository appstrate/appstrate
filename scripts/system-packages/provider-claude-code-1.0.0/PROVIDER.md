# Claude Code (Anthropic)

OAuth-bound model provider that bills against the connected user's
Claude Pro / Max / Team subscription via the Claude Code OAuth client.
Calls `api.anthropic.com/v1/messages` using the `anthropic-messages`
API shape.

## How agents use it

After an admin connects via Settings > Models, the platform resolves
the agent's selected model to a Claude-compatible model id and the
sidecar injects the OAuth bearer + Claude Code identity prelude into
every `/v1/messages` call. The agent never sees the token.

## Pricing model

No per-token billing on Appstrate's side — usage counts against the
connected Claude subscription's quota. The platform records the
provider's `usage` field (input/output/cache tokens, service tier,
cache hits) for observability but does not multiply it against a
$/token cost grid.

## Limits

The connected subscription has a usage allowance metered in 5-hour
windows by Anthropic. When the quota is exhausted, the long-context
beta (`context-1m-2025-08-07`) gets stripped automatically by the
sidecar (best-effort fallback) and the request is retried once. If
the secondary attempt also fails, the error is propagated verbatim
and the agent run fails.

## Models

The selectable model list is curated in Appstrate's runtime registry
(`apps/api/src/services/oauth-model-providers/registry.ts`) and
refreshed at each Appstrate release as Anthropic ships new variants.
As of this release: 16 variants from `claude-haiku-4-5` to
`claude-opus-4-7`, with Sonnet/Opus 4-x supporting long-context-1m.

## Identity prelude

The sidecar prepends the Claude Code identity block (`"You are Claude
Code, Anthropic's official CLI for Claude."`) into the `system` array
of every request. This is required for the subscription path to
accept the request — Anthropic gates the OAuth flow on Claude Code's
own identity. The agent prompt is preserved unchanged after the
identity block.

## Important notes

- This connection is shared by every member of the organization.
- Automated 24/7 agentic use isn't covered by your personal
  subscription's terms — use at your own risk.
- The connection can be revoked at any time on the provider side; the
  worker will detect this and surface a "Reconnection required" badge
  in the UI.
