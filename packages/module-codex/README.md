# @appstrate/module-codex

Appstrate module that contributes an OAuth model provider for **ChatGPT Plus / Pro / Business** via the Codex client_id. Opt-in.

## Why a separate module

Codex sits in a ToS grey zone — OpenAI's consumer Terms of Use lack an explicit Anthropic-style ban on third-party OAuth tools, but the public client_id allowlist and the reverse-engineered `chatgpt.com/backend-api` wire format are policy-fragile. Self-hosters opt in deliberately rather than getting it by default.

The platform core has zero knowledge of Codex — provider id, OAuth client, wire format quirks, and JWT identity claims all live here. Removing `@appstrate/module-codex` from `MODULES` leaves no `codex` providerId in the registry, no UI surface, no traffic.

## Enabling

Append the specifier to your `MODULES` env var:

```
MODULES=oidc,webhooks,mcp,core-providers,@appstrate/module-chat,@appstrate/module-codex
```

The platform resolves it via dynamic import — workspace resolution finds it locally during development; in production it must be installed (it ships as a workspace package and is bundled by the build).

## What it contributes

- `modelProviders()` → one `ModelProviderDefinition` with `providerId: "codex"`, `apiShape: "openai-codex-responses"`, OAuth metadata pointing at `auth.openai.com`, and the chatgpt.com Codex backend URL. It contributes **no** `oauthWireFormat` (nothing is forged) — Pi's SDK emits the codex-responses request shape natively. There is no per-provider execution-engine binding: codex agent runs execute on the single Pi engine like any other subscription provider (see Execution status below).
- Provider `hooks` — `extractTokenIdentity` decodes the access JWT to surface `chatgpt_account_id` / `email`; `buildApiKeyPlaceholder` builds the synthetic JWT the agent container sees; `validateCredential` validates a credential **offline** (no network) by decoding the access JWT and confirming it carries `chatgpt_account_id` and is unexpired. It declares `credentialValidation: "offline"`, so the platform issues **zero** Codex API calls to test a credential or discover models — discovery persists the static `modelDiscoveryCandidates` (∩ catalog), and real per-model availability is validated at the first agent run (on the Pi engine).

No DB tables, no routes, no workers — the unified `model_provider_credentials` table in core holds the OAuth blob.

## Client-side helper

The OAuth dance must run on the user's machine — OpenAI's authorize endpoint only allowlists loopback redirect URIs. Appstrate ships [`@appstrate/connect-helper`](https://www.npmjs.com/package/@appstrate/connect-helper) for this purpose; the dashboard mints a pairing token and surfaces `npx @appstrate/connect-helper@latest <token>`. The helper binds `127.0.0.1:1455`, completes the PKCE flow, and POSTs the resulting credentials back to the platform.

The helper's source lives in a separate private repo (`appstrate/connect-helper`) — the published npm package is public so `npx` works without auth. No setup is required from the operator beyond enabling this module on the platform side.

## Authoring follow-on OAuth providers

This module is a canonical example. Copy the shape: declare a `ModelProviderDefinition` with `authMode: "oauth2"` and provide `hooks` if the access token needs to be decoded for an identity claim or a credential-validation probe is required. The client-side helper (`@appstrate/connect-helper`) registers each provider by canonical `providerId` in its own `MODEL_PROVIDERS` table — extending it requires a coordinated bump.

> **Execution status.** Codex agent runs are **executable**. They run on the single Pi engine (`@mariozechner/pi-coding-agent`) like any other subscription provider — there is no separate "official binary" path and no per-provider execution-engine binding. Pi's SDK (`@mariozechner/pi-ai`) natively emits the codex-responses OAuth request shape (`chatgpt-account-id`, the codex user-agent), so the platform forges nothing: the real subscription token never enters the agent container (it gets a placeholder bearer), and the sidecar `/llm` oauth branch swaps in the real token server-side (bearer-swap only). Subscription runs still require an isolating orchestrator (docker/firecracker) because the bearer-swap lives on the sidecar path. This remains an operator opt-in grey-zone choice — see [`docs/architecture/SUBSCRIPTION_COMPLIANCE.md`](../../docs/architecture/SUBSCRIPTION_COMPLIANCE.md). Append `@appstrate/module-codex` to `MODULES` to enable it.
>
> **Chat:** Codex has **no chat surface.** It is excluded from the chat model list (`CHAT_USABLE_FAMILIES`) and contributes no `chatHandler`, so it never appears in the conversational assistant.
