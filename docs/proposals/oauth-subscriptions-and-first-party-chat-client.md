# Review rationale — LLM-proxy OAuth subscriptions + first-party chat client

> Branch: `feat/llm-proxy-oauth-subscriptions` (on top of `575f5835`)
> Author: Olivier (with Claude) · Date: 8 June 2026
> Audience: **Pierre** — these changes touch your `llm-proxy` and `oidc` modules.
> Goal of this doc: let you review the intent in ~10 min instead of reverse-
> engineering it from the diff.

## TL;DR

A standalone **chat satellite** (separate repo, AI SDK v6 — not the Pi runtime)
needs to: (1) drive Appstrate via your **MCP** server, and (2) run **inference**
through the **llm-proxy** — using the user's own **ChatGPT / Claude
subscription**, over OAuth, no API key. Two gaps had to be closed in OSS, both
by **reusing your existing declarative mechanisms rather than inventing new
ones**:

1. The llm-proxy didn't expose subscription providers → applied your declarative
   `oauthWireFormat` generically in the proxy (mirror of the sidecar).
2. Zero-config DCR can't grant `llm-proxy:call`/`models:read` → added a
   **trusted first-party `appstrate-chat` client**, via a declarative registry
   that subsumes `ensure-cli-client`.

Nothing here loosens a security boundary you set. Everything is on a branch,
never pushed onto yours.

## What changed, and the design intent

### 1. Subscriptions over the llm-proxy (commits `9dd16deb`, `314e44f3`, `3d2bfde8`)

The chat is runtime-less, so it can't use the run **sidecar** — it must reach a
subscription through the **proxy**. Instead of hardcoding ChatGPT/Claude
internals, the proxy now applies the provider's declarative `oauthWireFormat`
**generically**, exactly the contract the sidecar applies:

```
core.ts (proxyLlmCall):
  resolve model → getModelProvider(providerId).oauthWireFormat
  applyOauthWireFormat()  // authMode oauth2: strip x-api-key, Authorization: Bearer,
                          // identityHeaders + accountIdHeader   ← buildIdentityHeaders
  applyOauthBody()        // systemPrepend + forceStream/forceStore  ← transformBody
  adaptHeaderForRetry()   // 1-shot beta-strip retry            ← adaptHeaderForRetry
```

- The proxy **never branches on `providerId`** — same principle as the sidecar.
- New adapter `openai-codex-responses.ts` (mirrors `anthropic.ts`): protocol
  shape only (Bearer + Responses-API usage); the codex quirk headers live on the
  provider's declarative block, applied by the core.
- **Verified live** end-to-end against a real ChatGPT subscription **and** a
  Claude Pro subscription (streamed answer + MCP tool calls through the chat).

**Faithful?** Yes — this is your sidecar's wire-format contract, lifted to the
proxy so a subscription works without a runtime.

**Your call to ratify:**

- Do you want subscriptions reachable over the proxy at all? (The `anthropic.ts`
  docstring deliberately refused OAuth tokens for ToS reasons. Owner asserts:
  permitted by OpenAI now, by Anthropic from **15 June** — so the Anthropic path
  is code-ready but should not ship before then.)
- `adaptiveRetry` ported into the proxy (was sidecar-only) — keep?

### 2. Declarative first-party client registry (commit `24b3b354`)

Zero-config DCR is bounded (correctly) to identity + MCP — it rejects
`llm-proxy:call`/`models:read`. The chat is a **first-party app**, so the right
answer is a **trusted seeded client** (your `appstrate-cli` pattern), not
loosening DCR.

`services/first-party-clients.ts` is the declarative version of
`ensure-cli-client`:

```
registry = [
  { appstrate-cli,  scopes: [identity],                                   grant: device   },  ← migrated verbatim
  { appstrate-chat, scopes: [identity, mcp:read/invoke, models:read, llm-proxy:call], grant: authcode },  ← new
]
ensureFirstPartyClients()  // idempotent seed of each, on boot
```

- `ensure-cli-client.ts` is now a thin **re-export** — call sites and tests
  unchanged. The CLI entry is **byte-identical** to before.
- The chat client: public PKCE, **consent kept** (so the user picks the org —
  the grant binds to it), `skipConsent: false`, least-privilege scopes,
  redirect URIs from `APPSTRATE_CHAT_REDIRECT_URIS` (localhost default).
- Tokens stay **role-filtered at issuance** (`auth/claims.ts`), so the broad
  client scope never escalates a member.
- **Verified live**: `/authorize?client_id=appstrate-chat` with the inference
  scopes is accepted (302 → login).
- **Audience confinement → two tokens per connection.** Your
  `protected-resources.ts` confines a token bound to `/api/mcp` _to_ `/api/mcp`
  (inbound requires the resource in `aud`; outbound rejects any token bound to a
  protected resource). So a single token can't serve **both** MCP and inference
  — they want mutually-exclusive audiences. The chat therefore requests **both**
  resources at `/authorize` (`resource=<root>` **and** `resource=<root>/api/mcp`
  — your AS accepts multiple, 302 verified) and mints **two** audience-bound
  tokens from the one grant: a `<root>`-audience token for `/api/llm-proxy` +
  `/api/models`, and a `/api/mcp`-audience token for the MCP client. Both come
  from one consent (code → inference token + refresh; refresh → mcp token).
  Confirmed against the code: only `/api/mcp` is a registered protected resource
  (`mcp/router.ts`), so the `<root>`-audience token passes the outbound check.

**Faithful?** Yes — same trust model as the CLI; just declarative so the future
`appstrate-workspace` is one entry, not a new file.

**Your call to ratify:**

- Should `appstrate-chat` live in **core** OSS (first-party, like the CLI), or
  be operator-configured? It's seeded only when its redirect URIs are set.
- Should it be added to the orphan-whitelist in `instance-client-sync.ts` (the
  CLI is)? — flagged as a likely follow-up, not done here.
- **Two-token dance vs a broad first-party audience.** A first-party client that
  needs both MCP and inference must currently hold two audience-bound tokens
  (above). That's faithful to your confinement model and lives entirely
  chat-side (no OSS change). If you'd rather a _trusted_ first-party client get a
  single token valid across the instance (e.g. an opt-in `audience: instance`
  for seeded clients, MCP accepting a root-audience token), that's a small OSS
  affordance that would collapse the dance to one token. Flagged for your call —
  not done, since it loosens the confinement you deliberately set.

## Security

A background security review flagged the **chat-side** connection code (SSRF +
auth-gating); both fixed there (separate repo). On the **OSS** side: no boundary
was loosened — DCR bounds untouched, org-binding (`org-context.ts`) untouched,
audience model followed (`resource=…/api/mcp`).

## Known DRY debt (deliberate, deferred)

`core.ts` **duplicates** the sidecar's `oauth-identity.ts` pure functions
(`buildIdentityHeaders` / `transformBody` / `adaptHeaderForRetry`) because they
live in `runtime-pi/sidecar` and weren't importable from the API. The clean end
state is to extract them to `@appstrate/core/oauth-wire-format` and have both the
sidecar and the proxy consume them — a one-source-of-truth for the wire-format
contract. Not done here (touches the runtime path, wanted your eyes first). The
proxy copies carry `// mirrors the sidecar` markers.

## Commits (this branch, on top of `575f5835`)

| Commit     | What                                                                   |
| ---------- | ---------------------------------------------------------------------- |
| `9dd16deb` | codex (ChatGPT) llm-proxy family + 3-tool generic application          |
| `314e44f3` | OAuth wire-format → Bearer auth + body transforms (unblocks Anthropic) |
| `3d2bfde8` | adaptive-retry ported to the OAuth path                                |
| `24b3b354` | declarative first-party client registry + `appstrate-chat`             |

Quality gates pass on each: `bunx tsc`, `bun test apps/api/test/unit/llm-proxy-adapters.test.ts`, `bun run verify:openapi`, `bun run detect:breaking` (0 breaking).

## The consumer (context, separate repo)

`appstrate-chat` (Bun/Hono + AI SDK v6 + assistant-ui). It points AI SDK
providers at `/api/llm-proxy/<family>`, the `@ai-sdk/mcp` http client at
`/api/mcp`, and authenticates as `appstrate-chat` with a per-(instance, org)
OAuth connection. It does **not** reimplement anything in OSS — it consumes it.
