<!-- SPDX-License-Identifier: Apache-2.0 -->

# Subscription Credential Compliance Posture

**Last reviewed: 2026-06-21.** The third-party-subscription ToS landscape shifted
repeatedly through 2026 (ban → enforce → reverse → pause for Anthropic; unblocked
but unendorsed for OpenAI). **Re-verify the current vendor terms before relying on
this document** — the policy half is volatile; the code half is stable.

This document records exactly how Appstrate uses model-provider **subscription**
credentials (Claude Pro/Max via `claude-code`, ChatGPT Plus/Pro/Business via
`codex`), what we can guarantee at the code level, and what we deliberately do
**not** claim.

---

## 1. What is guaranteed in code

These are properties of the implementation, verifiable by reading the source —
not policy opinions.

### 1.1 Official vendor tools only, on every axis

A subscription credential is **only ever** driven through the vendor's own
official binary, which signs its own client fingerprint. There is no
reimplementation of either vendor's wire protocol for subscription auth.

| Provider      | Chat                                                    | Agents (sandboxed run)                               |
| ------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| `claude-code` | `@anthropic-ai/claude-agent-sdk` `query()` (in-process) | `ClaudeAgentRunner` → official `claude` binary       |
| `codex`       | _none_ — agent-only (no chat surface)                   | `CodexAgentRunner` → official `@openai/codex` binary |

Codex has **no chat surface**: its subscription token can't be safely held
host-side (the CLI talks to chatgpt.com directly, so the chat host would hold the
real token), so it runs only as a docker-isolated agent. The Claude subscription
is chat-usable because its gateway swaps the bearer server-side.

Anchors: `packages/module-chat/src/claude-agent/engine.ts`,
`packages/runner-claude/`, `packages/runner-codex/`, `runtime-pi/entrypoint.ts`
(`buildClaudeAgentRunner` / `buildCodexAgentRunner`).

### 1.2 No fingerprint forging — and no forging fallback

- The OAuth-subscription **fingerprint-forging** primitives (identity headers,
  system-prepend, `wireFormat` body transforms, originator spoofing) were
  removed (commit `a2c664f7c`). A repo-wide grep for forging primitives in
  product code returns nothing.
- A subscription credential that resolves to a non-official engine is **hard
  refused**, never forged onto the Pi loop:
  `assertRunnableOnEngine` throws `UnrunnableOauthProviderError` unless the
  engine is `claude` or `codex`
  (`apps/api/src/services/run-launcher/engine-select.ts`).

### 1.3 What the upstream actually receives

- **Claude (`/llm` oauth gateway, sidecar):** the only mutations are (a) swap the
  placeholder bearer for the user's **own** real subscription token, and (b)
  ensure the documented `anthropic-beta: oauth-2025-04-20` flag is present. The
  binary's own `user-agent` / `x-app` / `anthropic-beta` are forwarded
  **untouched** (`runtime-pi/sidecar/app.ts` → `handleOauthLlmRequest`).
- **Codex (vend):** the binary talks to `chatgpt.com` directly. Its
  `CODEX_HOME/auth.json` carries the **real** access token and the **real**
  `chatgpt_account_id`. The synthetic `id_token` (`alg:none`) is **local-only**
  CLI-bootstrap data — never transmitted; only the real token is sent as the
  Bearer (`packages/core/src/codex-binary.ts` → `buildCodexAuthJson`).

So each upstream sees its own official client's fingerprint plus a genuine,
per-user subscription token. No impersonation of another client; no pooling —
the credential is per-user/org and never shared across tenants.

### 1.4 Credential isolation (agents)

For agent runs the real token is **vended once** into the sandboxed container and
the container's egress is **locked** to the provider's hosts:

- The sidecar `GET /credential-vend` hands over the resolved token **only** for a
  `vend`-mode run; `oauth` (Claude) and `api_key` runs `403`, preserving their
  no-real-token-in-container invariant (`runtime-pi/sidecar/app.ts`).
- The forward proxy enforces a per-run egress allowlist (`chatgpt.com`,
  `openai.com`) on top of the always-on SSRF blocklist
  (`runtime-pi/sidecar/forward-proxy.ts`,
  `apps/api/src/services/run-launcher/engine-select.ts` → `CODEX_EGRESS_ALLOWLIST`).
- The vended access token is **non-renewable** (no refresh token is handed over)
  and the container is ephemeral.

This means: even though the real Codex token lives in-container (the CLI calls
`chatgpt.com` directly and cannot be reverse-proxied), it cannot be exfiltrated to
an attacker-controlled host, and it cannot be refreshed.

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
identity (the official `claude` binary signs its own), but that does NOT confer
approval. Treat the subscription engines as an operator-owned grey-zone choice,
not a sanctioned integration, and re-verify the quote against the live docs
(§4) before relying on it — the wording and policy have changed repeatedly.

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
API), billed pay-as-you-go. The subscription engines (`claude-code`, `codex`) are
a convenience/grey-zone option chosen per-operator; they are not the recommended
substrate for production automation.

---

## 4. Re-verification checklist

Before depending on a subscription engine in production, confirm against the
**current** vendor docs:

- [ ] Anthropic Consumer Terms + Usage Policy + Help Center (Agent SDK /
      `claude -p` / third-party app authentication, and whether subscription
      quotas still apply or a separate programmatic credit is in force).
- [ ] OpenAI Service Terms + Usage Policies ("Sign in with ChatGPT" in
      third-party/forked clients; automated/headless use).
- [ ] Whether either vendor has since blocked the third-party OAuth path
      (technical break) — a `410`/`401` storm on the relevant credential is the
      operational signal.
