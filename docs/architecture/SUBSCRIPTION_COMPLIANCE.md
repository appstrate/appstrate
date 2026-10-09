<!-- SPDX-License-Identifier: Apache-2.0 -->

# Subscription Credential Compliance Posture

**Last reviewed: 2026-10-09.** The Anthropic facts come from Anthropic's primary
page (§2.1); the OpenAI sharing-scope facts still come from a secondary source
(§2.2). The third-party-subscription ToS landscape shifted repeatedly through
2026 (ban → enforce → reverse → pause for Anthropic; a plan-usage sharing scope
for OpenAI). **Re-verify the current vendor terms before relying on this
document** — the policy half is volatile; the code half is stable.

This document records exactly how Appstrate uses model-provider **subscription**
credentials (Claude Pro/Max via `claude-code`, ChatGPT Plus/Pro/Business via
`codex`), what we can guarantee at the code level, and what we deliberately do
**not** claim.

> **Single execution engine.** There is **one** agent-run engine: Pi
> (`@earendil-works/pi-coding-agent`). API-key providers **and** OAuth
> subscription providers (Claude Pro/Max, ChatGPT Codex) all execute on it —
> there is no "official binary" run path, no Claude Agent SDK engine, no
> `RunEngine` / `subscriptionEngine` provider→engine binding (that vocabulary
> was removed). Both subscription providers (`claude-code`, `codex`) are
> **executable** for agent runs and share the **identical** delivery mechanism
> (below). They remain **opt-in** modules — not in the `MODULES` default.

> **Operator decision (2026-10-09).** `@appstrate/module-claude-code` and
> `@appstrate/module-codex` are opt-in and are **never enabled on the Appstrate
> production deployment** (`deploy/`). Self-hosters who enable them own the risk.
> Production therefore runs API-key providers only.

---

## 1. What is guaranteed in code

These are properties of the implementation, verifiable by reading the source —
not policy opinions.

### 1.1 Pi formats the request; the platform forges nothing

Subscription requests are built by **Pi's SDK** (`@earendil-works/pi-ai`), which
natively emits each provider's subscription request shape / fingerprint — the
Anthropic OAuth fingerprint (`anthropic-beta: oauth-2025-04-20`, the `claude-cli`
user-agent, the "You are Claude Code" system prelude) for `claude-code`, and the
codex-responses shape (`chatgpt-account-id`, the codex user-agent) for `codex`.
This is exactly what any `pi` / `pi-mono` CLI user's requests look like — the
request-shape responsibility is **delegated to Pi**, not reimplemented by
Appstrate. The platform issues **zero** subscription API calls of its own for
credential-testing or model discovery (see §1.4); every request a subscription
token authenticates is emitted by Pi at run time.

| Provider      | Chat                        | Agents (sandboxed run)          |
| ------------- | --------------------------- | ------------------------------- |
| `claude-code` | Pi chat engine (in-process) | Pi engine (sidecar bearer-swap) |
| `codex`       | Pi chat engine (in-process) | Pi engine (sidecar bearer-swap) |

Both subscription providers share the SAME two paths: the generic in-process Pi
chat engine (`@appstrate/module-chat`, `src/pi-chat/` — the real token stays in
the platform process, registered in an in-memory AuthStorage) and the sandboxed
Pi run loop (placeholder token in the container, verbatim bearer-swap on the
sidecar `/llm` path). There is no per-provider engine or handler anywhere.

### 1.2 No fingerprint forging

- The OAuth-subscription **fingerprint-forging** primitives (identity headers,
  system-prepend, `wireFormat` body transforms, originator spoofing) were
  removed. A repo-wide grep for forging primitives in product code returns
  nothing.
- Pi emits the subscription fingerprint itself; the platform neither forges one
  nor patches Pi's request. The sidecar's only header policy on the OAuth path
  is a **bearer-swap** (§1.3) — provider-neutral, touching no provider-specific
  header.

### 1.3 Bearer-swap delivery — the real token never enters the container

Both subscription providers share **one** delivery mechanism. The agent
container is handed a **placeholder** bearer; the real subscription token never
crosses the isolation boundary. Pi in the container calls the sidecar's `/llm`
endpoint, and the sidecar's OAuth branch resolves the user's **own** real
subscription token **server-side** and swaps it onto the outbound request
(`applyOauthBearerSwap` from `@appstrate/core/oauth-bearer-swap`): it forces the
real bearer onto `authorization`, drops any stray `x-api-key`, and forwards
**every other header Pi signed verbatim** (`runtime-pi/sidecar/app.ts`, oauth
`/llm` branch). The swap is provider-neutral — the same code serves Claude and
Codex; Pi's fingerprint (user-agent, `anthropic-beta`, `chatgpt-account-id`, …)
rides through unchanged.

The body is forwarded **byte-identical** — the oauth sidecar mode carries no
body-rewrite capability at all (`LlmProxyOauthConfig` has no `modelSwap`). The
platform's model-alias feature is **rejected for oauth-subscription providers**
at alias creation and update (`POST`/`PUT /api/models` → 400), again fail-closed
at run launch, and refused by the subscription chat resolver — so no alias ever
reaches this path. Aliases remain available on API-key providers, whose sidecar
mode does the alias↔real body swap.

The one honest narrowing: the upstream TLS request is made by the **sidecar's
`fetch`** carrying Pi's forwarded headers, not by a vendor binary — so we do not
claim transport-level client identity. The token is genuine and belongs to one
user (never pooled across tenants); no impersonation of another client, no
forging.

Subscription runs require an isolating orchestrator (docker / firecracker): the
plain `process` adapter runs the agent and its sidecar as host processes of one
user, so nothing keeps the agent from the sidecar's environment, and
subscription credentials are not delivered there.

### 1.4 Zero platform-side subscription API calls — offline validation only

The platform never sends a request that a subscription token authenticates.
Two paths that historically would have (connection test + per-model discovery)
are now **offline**:

- **Connection test** (`POST /api/models/test`, `/api/models/:id/test`): for a
  provider that defines the `validateCredential` hook, the platform runs that
  hook instead of any network call — a **structural, offline** check (decode +
  required claims + expiry). There is no flag to set: the hook's presence is the
  signal (`packages/core/src/module.ts`). Codex decodes the access JWT and
  confirms it carries `chatgpt_account_id` and has a verifiable, unexpired expiry
  (the row's `expiresAt` or the token's `exp` claim); Claude (whose OAuth tokens
  are not JWTs) confirms the bearer is well-formed and the credential row carries
  an unexpired `expiresAt`. When **no** expiry source is present the credential
  is rejected — a dead token with no expiry metadata must not pass. `{ ok: true }`
  ⇒ structurally well-formed with a verifiable, unexpired expiry; otherwise
  `AUTH_FAILED`. No request is sent to `chatgpt.com` or `api.anthropic.com`
  (`apps/api/src/services/org-models.ts` → `testModelConfig`).

  **What this check does NOT prove.** It is **not** a cryptographic signature
  verification (the JWT signature is never checked — the platform cannot, offline,
  hold the vendor's signing key) and **not** a live backend call. A structurally
  valid, unexpired token can still be revoked, throttled, or otherwise dead
  upstream. Real end-to-end credential validity — that the token is live and
  authentic — is established only at the **first agent run** (Pi presents the
  credential to the real backend). The offline check is a cheap, no-spend
  structural gate that catches malformed and expired credentials early; it is
  not proof of liveness.

- **Model discovery**: a `modelDiscovery: { mode: "static" }` provider is never
  enumerated — `POST /api/model-provider-credentials/discover` refuses it with a
  `400` before any request. Its models are the provider's offer — the records of
  its Pi provider (`openai-codex`, `anthropic`) in Pi's pinned model registry,
  which ships with the SDK and is read locally — so they are identical for
  every credential of the provider and nothing is stored per credential. Real
  per-model availability surfaces at the first agent run, not via a
  platform-side request.

The `validateCredential` hook is a provider-agnostic core contract
(`packages/core/src/module.ts`): the platform asks "does this provider validate
offline?" by checking for the hook, never by hardcoding `codex` / `claude-code`.
API-key providers omit the hook and keep the empirical `/models` probe, except a
`publicModelListing` provider (its listing ignores the key), which is checked
with one minimal chat completion instead.

This keeps §1.1's "zero platform-side subscription API calls" claim literally
true for the test/discovery paths, not just the run path. The earlier hand-built
`${baseUrl}/codex/responses` / `/v1/messages` probe requests (which forged an
`originator: "pi"` client id and sent the subscription bearer directly from the
platform process) have been **deleted**, along with the now-unused
`buildInferenceProbe` / `InferenceProbeRequest` / `runInferenceProbe` machinery.

### 1.5 Subscription credentials are personal, by construction (#1875)

For any credential whose provider has `authMode: "oauth2"` (a subscription):

- it is **always personal**: owned by the user who connected it
  (`model_provider_credentials.owner_user_id`), never an organization credential;
- it is **never bound to an organization model**: an `org_models` row can only
  reference an organization credential;
- it serves **only its owner's** runs, schedules and chat. For any other run the
  sidecar token door refuses to hand it out (`assertOAuthModelCredential`,
  `apps/api/src/routes/internal.ts`), as defence in depth behind the resolution step.

Holder-only use removes the aggravation of several people
sharing one subscription. It does **not** make the `claude-code` path compliant
(§2.1).

---

## 2. What is NOT claimed

**Appstrate does not certify "100% ToS compliance."** That is a legal/policy
determination, not a code property, and the 2026 terms are volatile. Operators
opt into subscription providers deliberately (via `MODULES`) and own that choice.
On the production deployment they are not opted into at all (see the operator
decision at the top).

### 2.1 Anthropic / `claude-code` — not permitted by the vendor's terms

Primary source: Anthropic's
[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
page, read 2026-10-09:

- OAuth sign-in is intended for purchasers of Free, Pro, Max, Team and Enterprise
  plans, using Claude Code and Anthropic's own applications. Developers building
  products use API keys.
- Third-party developers may not offer claude.ai login in their products, may not
  route requests through Free, Pro or Max credentials on behalf of their users, and
  may not collect, store or intermediate claude.ai credentials or session tokens.
- The one hosted path the page admits: run the **unmodified** Claude Code binary,
  where each end user signs in with their own subscription, and the customer does
  not pay for, resell or intermediate that usage.

Appstrate does what that text excludes. `connect-helper` POSTs the subscription
token, the platform stores it, and Pi — not Claude Code — presents it on the run
path through the sidecar bearer-swap (§1.3). The module is therefore outside the
admitted path. Holder-only use (§1.5) removes the aggravation of several people
sharing one subscription; it does not make the path compliant.

- 2026 timeline: **Feb 20** banned subscription-OAuth in third-party tools →
  **Apr 4** billing enforcement → **May 13** reversal explicitly re-allowing
  third-party apps to authenticate via the Agent SDK → a **June 15** credit-pool
  change was **paused**.
- The June 2026 reading ("aligned with Anthropic's stated position") no longer
  holds: the October page above excludes this path.
- For production/team automation Anthropic itself recommends **API-key billing**.

> **Earlier wording, Anthropic's Agent SDK docs (quoted verbatim, observed 2026-06-22):**
>
> "Unless previously approved, Anthropic does not allow third party developers to
> offer claude.ai login or rate limits for their products, including agents built
> on the Claude Agent SDK. Please use the API key authentication methods described
> in this document instead."

This is the crux: an operator pointing Appstrate's chat/runner at a **personal**
Claude subscription is doing what the page excludes. Appstrate forges no client
identity (Pi's SDK emits the subscription fingerprint, same as any Pi CLI user),
but that confers no approval. Treat `claude-code` as a risk a self-hoster may
take by enabling the module, not as a sanctioned integration, and never enable it
in production. Re-verify the live page (§4) before relying on this reading.

### 2.2 OpenAI / `codex` — a sharing scope exists, the Codex client path is still a grey zone

- **Since 2026-09-29**, "Sign in with ChatGPT" has a **plan-usage sharing scope**
  (`chatgpt.tokens.use.direct`) for Plus and Pro subscribers. The user sets a
  weekly cap per app; when the cap is reached the API answers
  `429 subscription_sharing_usage_limit_exceeded`. Hosted commercial apps go
  through an interest form. Per the same source, Pi and OpenCode are among the 16
  launch partners.
- **Source status: reported by a secondary source (WorkOS), primary page not
  verified.** OpenAI's help page answered 403 when checked. Verify the scope on
  OpenAI's own documentation before relying on it.
- `module-codex` uses the Codex `client_id` and a synthesized `auth.json`, outside
  that program. It stays in the grey zone described below.
- OpenAI has **not** banned subscription-OAuth in third-party/headless tools
  (unlike Anthropic in Feb), and it works. But outside the sharing scope there is
  **no official endorsement** for automated/third-party use. The path relies on
  the Codex `client_id` OAuth flow plus a synthesized `auth.json` outside the
  official login. This is policy-fragile and could be closed at any time, as
  Anthropic did.
- This grey-zone status is self-documented in `packages/module-codex/src/index.ts`.
- For headless/automated work, OpenAI's clean contract is **API-key billing**.

---

## 3. The clean path for production

For automated / headless / team workloads on **either** vendor, the contractually
unambiguous option is an **API-key** model provider (OpenAI Platform / Anthropic
API), billed pay-as-you-go. The subscription providers (`claude-code`, `codex`)
are a convenience/grey-zone option chosen per-operator; they are not the
recommended substrate for production automation, and they are **not enabled** on
the production deployment. Holder-only (§1.5) is necessary, not sufficient.

---

## 4. Re-verification checklist

Before depending on a subscription provider in production, confirm against the
**current** vendor docs:

- [ ] Anthropic [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
      page, Consumer Terms, Usage Policy and Help Center (third-party app
      authentication, `claude -p`, Agent SDK, and whether subscription quotas still
      apply or a separate programmatic credit is in force).
- [ ] OpenAI Service Terms + Usage Policies ("Sign in with ChatGPT" in
      third-party/forked clients; the plan-usage sharing scope of §2.2, checked on
      OpenAI's own page; automated/headless use).
- [ ] Whether either vendor has since blocked the third-party OAuth path
      (technical break) — a `410`/`401` storm on the relevant credential is the
      operational signal.
