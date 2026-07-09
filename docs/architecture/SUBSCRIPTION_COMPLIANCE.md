<!-- SPDX-License-Identifier: Apache-2.0 -->

# Subscription Credential Compliance Posture

**Last reviewed: 2026-07-08** (code half rewritten for the single Pi execution
engine). The third-party-subscription ToS landscape shifted repeatedly through
2026 (ban → enforce → reverse → pause for Anthropic; unblocked but unendorsed for
OpenAI). **Re-verify the current vendor terms before relying on this document** —
the policy half is volatile; the code half is stable.

This document records exactly how Appstrate uses model-provider **subscription**
credentials (Claude Pro/Max via `claude-code`, ChatGPT Plus/Pro/Business via
`codex`), what we can guarantee at the code level, and what we deliberately do
**not** claim.

> **Single execution engine.** There is **one** agent-run engine: Pi
> (`@mariozechner/pi-coding-agent`). API-key providers **and** OAuth
> subscription providers (Claude Pro/Max, ChatGPT Codex) all execute on it —
> there is no "official binary" run path, no Claude Agent SDK engine, no
> `RunEngine` / `subscriptionEngine` provider→engine binding (that vocabulary
> was removed). Both subscription providers (`claude-code`, `codex`) are
> **executable** for agent runs and share the **identical** delivery mechanism
> (below). They remain **opt-in** modules — not in the `MODULES` default.

---

## 1. What is guaranteed in code

These are properties of the implementation, verifiable by reading the source —
not policy opinions.

### 1.1 Pi formats the request; the platform forges nothing

Subscription requests are built by **Pi's SDK** (`@mariozechner/pi-ai`), which
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

The one honest narrowing: the upstream TLS request is made by the **sidecar's
`fetch`** carrying Pi's forwarded headers, not by a vendor binary — so we do not
claim transport-level client identity. The token is genuine and per-user/org
(never pooled across tenants); no impersonation of another client, no forging.

Because the bearer-swap exists **only on the sidecar path**, subscription runs
still require an isolating orchestrator (docker / firecracker) — there is no
sidecar in the plain `process` adapter, so subscription credentials are not
delivered there.

### 1.4 Zero platform-side subscription API calls — offline validation only

The platform never sends a request that a subscription token authenticates.
Two paths that historically would have (connection test + per-model discovery)
are now **offline**:

- **Connection test** (`POST /api/models/test`, `/api/models/:id/test`): for a
  provider that declares `credentialValidation: "offline"` the platform runs the
  module's `validateCredential` hook — a **structural, offline** check (decode +
  required claims + expiry), no network. Codex decodes the access JWT and
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

- **Model discovery** (`POST /api/model-provider-credentials/:id/refresh-models`):
  for offline providers the platform persists the provider's static
  `modelDiscoveryCandidates` (∩ catalog) as `available_model_ids` **without
  probing** any candidate. Real per-model availability surfaces at the first
  agent run, not via a platform-side request
  (`apps/api/src/services/model-providers/model-discovery.ts` →
  `persistStaticCandidates`).

The `validateCredential` hook + `credentialValidation` flag are provider-agnostic
core contracts (`packages/core/src/module.ts`): the platform asks "does this
provider validate offline?" by data, never by hardcoding `codex` / `claude-code`.
API-key providers leave the flag unset and keep the empirical `/models` probe.

This keeps §1.1's "zero platform-side subscription API calls" claim literally
true for the test/discovery paths, not just the run path. The earlier hand-built
`${baseUrl}/codex/responses` / `/v1/messages` probe requests (which forged an
`originator: "pi"` client id and sent the subscription bearer directly from the
platform process) have been **deleted**, along with the now-unused
`buildInferenceProbe` / `InferenceProbeRequest` / `runInferenceProbe` machinery.

---

## 2. What is NOT claimed

**Appstrate does not certify "100% ToS compliance."** That is a legal/policy
determination, not a code property, and the 2026 terms are volatile. Operators
opt into subscription providers deliberately (via `MODULES`) and own that choice.

### 2.1 Anthropic / `claude-code` — currently aligned, historically volatile

- 2026 timeline: **Feb 20** banned subscription-OAuth in third-party tools →
  **Apr 4** billing enforcement → **May 13** reversal explicitly re-allowing
  third-party apps to authenticate via the Agent SDK → a **June 15** credit-pool
  change was **paused**.
- As of 2026-06-21 this path is aligned with Anthropic's stated position, but it
  flipped four times this year.
- For production/team automation Anthropic itself recommends **API-key billing**.

> **Anthropic's own Agent SDK docs (quoted verbatim, observed 2026-06-22):**
>
> "Unless previously approved, Anthropic does not allow third party developers to
> offer claude.ai login or rate limits for their products, including agents built
> on the Claude Agent SDK. Please use the API key authentication methods described
> in this document instead."

This is the crux: an operator pointing Appstrate's chat/runner at a **personal**
Claude subscription is acting as a third-party product offering claude.ai login —
which Anthropic permits only with **prior approval**. Appstrate forges no client
identity (Pi's SDK emits the subscription fingerprint, same as any Pi CLI user),
but that does NOT confer approval. Treat the subscription providers as an
operator-owned grey-zone choice, not a sanctioned integration, and re-verify the
quote against the live docs (§4) before relying on it — the wording and policy
have changed repeatedly.

### 2.2 OpenAI / `codex` — a documented grey zone

- OpenAI has **not** banned subscription-OAuth in third-party/headless tools
  (unlike Anthropic in Feb), and it works.
- But there is **no official endorsement** for automated/third-party use. The
  path relies on the Codex `client_id` OAuth flow plus a synthesized `auth.json`
  outside the official login. This is policy-fragile and could be closed at any
  time, as Anthropic did.
- This grey-zone status is self-documented in `packages/module-codex/src/index.ts`.
- For headless/automated work, OpenAI's clean contract is **API-key billing**.

---

## 3. The clean path for production

For automated / headless / team workloads on **either** vendor, the contractually
unambiguous option is an **API-key** model provider (OpenAI Platform / Anthropic
API), billed pay-as-you-go. The subscription providers (`claude-code`, `codex`)
are a convenience/grey-zone option chosen per-operator; they are not the
recommended substrate for production automation.

---

## 4. Re-verification checklist

Before depending on a subscription provider in production, confirm against the
**current** vendor docs:

- [ ] Anthropic Consumer Terms + Usage Policy + Help Center (Agent SDK /
      `claude -p` / third-party app authentication, and whether subscription
      quotas still apply or a separate programmatic credit is in force).
- [ ] OpenAI Service Terms + Usage Policies ("Sign in with ChatGPT" in
      third-party/forked clients; automated/headless use).
- [ ] Whether either vendor has since blocked the third-party OAuth path
      (technical break) — a `410`/`401` storm on the relevant credential is the
      operational signal.
