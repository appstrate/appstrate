# Codex (ChatGPT)

OAuth-bound model provider that bills against the connected user's
ChatGPT Plus / Pro / Business subscription. Calls the Codex backend
(`https://chatgpt.com/backend-api`) using the `openai-responses` API
shape.

## How agents use it

After an admin connects via Settings > Models, the platform resolves
the agent's selected model to a Codex-compatible model id and the
sidecar injects the OAuth bearer + identity headers into every
`/v1/responses` call. The agent never sees the token.

## Pricing model

No per-token billing on Appstrate's side — usage counts against the
connected ChatGPT subscription's quota. The platform records request
metadata for observability but does not multiply it against a $/token
cost grid.

## Limits

The connected subscription has a shared usage allowance (rate limited
per 5-hour window per the ChatGPT Pro / Business terms). When the
quota is exhausted, OpenAI returns an error verbatim and the agent run
fails — Appstrate does not retry.

## Models

The selectable model list is curated in Appstrate's runtime registry
(`apps/api/src/services/oauth-model-providers/registry.ts`) and
refreshed at each Appstrate release as OpenAI deprecates models. As of
this release: `gpt-5.5` (default), `gpt-5.4`, `gpt-5.4-mini`,
`gpt-5.3-codex`, `gpt-5.2`.

## Important notes

- This connection is shared by every member of the organization.
- Automated 24/7 agentic use isn't covered by your personal
  subscription's terms — use at your own risk.
- The connection can be revoked at any time on the provider side; the
  worker will detect this and surface a "Reconnection required" badge
  in the UI.
