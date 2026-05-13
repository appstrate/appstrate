# @appstrate/module-codex

Appstrate module that contributes an OAuth model provider for **ChatGPT Plus / Pro / Business** via the Codex client_id. Opt-in.

## Why a separate module

Codex sits in a ToS grey zone — OpenAI's consumer Terms of Use lack an explicit Anthropic-style ban on third-party OAuth tools, but the public client_id allowlist and the reverse-engineered `chatgpt.com/backend-api` wire format are policy-fragile. Self-hosters opt in deliberately rather than getting it by default.

The platform core has zero knowledge of Codex — provider id, OAuth client, wire format quirks, and JWT identity claims all live here. Removing `@appstrate/module-codex` from `MODULES` leaves no `codex` providerId in the registry, no UI surface, no traffic.

## Enabling

Append the specifier to your `MODULES` env var:

```
MODULES=oidc,webhooks,core-providers,@appstrate/module-codex
```

The platform resolves it via dynamic import — workspace resolution finds it locally during development; in production it must be installed (it ships as a workspace package and is bundled by the build).

## What it contributes

- `modelProviders()` → one `ModelProviderDefinition` with `providerId: "codex"`, `apiShape: "openai-codex-responses"`, OAuth metadata pointing at `auth.openai.com`, the chatgpt.com Codex backend URL, and the wire-format headers (`originator`, `openai-beta`, `user-agent`, `accept`) the backend requires.
- Provider `hooks` — `extractTokenIdentity` decodes the access JWT to surface `chatgpt_account_id` / `email`; `buildApiKeyPlaceholder` builds the synthetic JWT the agent container sees; `buildInferenceProbe` issues a real one-token request against `${baseUrl}/codex/responses` for the connection test.

No DB tables, no routes, no workers — the unified `model_provider_credentials` table in core holds the OAuth blob.

## Client-side helper

The OAuth dance must run on the user's machine — OpenAI's authorize endpoint only allowlists loopback redirect URIs. Appstrate ships [`@appstrate/connect-helper`](https://www.npmjs.com/package/@appstrate/connect-helper) for this purpose; the dashboard mints a pairing token and surfaces `npx @appstrate/connect-helper@latest <token>`. The helper binds `127.0.0.1:1455`, completes the PKCE flow, and POSTs the resulting credentials back to the platform.

The helper's source lives in a separate private repo (`appstrate/connect-helper`) — the published npm package is public so `npx` works without auth. No setup is required from the operator beyond enabling this module on the platform side.

## Authoring follow-on OAuth providers

This module is the canonical example. Copy the shape: declare a `ModelProviderDefinition` with `authMode: "oauth2"`, provide `hooks` if the access token needs to be decoded for an identity claim, and pin any wire-format quirks in `oauthWireFormat`. The client-side helper (`@appstrate/connect-helper`) registers each provider by canonical `providerId` in its own `MODEL_PROVIDERS` table — extending it requires a coordinated bump.
