# @appstrate/module-claude-code

Appstrate module that contributes an OAuth model provider for **Claude Pro / Max / Team** via the Claude Code client_id. Opt-in.

## Why a separate module

Anthropic's [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) forbid using OAuth subscription tokens with any third-party product, tool, or service — including agentic SDKs. The OSS Appstrate platform therefore ships **no** Anthropic OAuth provider in its defaults. Operators who have reviewed the ToS posture and want to enable it do so deliberately by adding this module to `MODULES`.

The platform core has zero knowledge of Claude Code — provider id, OAuth client, and wire-format quirks all live here. Removing `@appstrate/module-claude-code` from `MODULES` leaves no `claude-code` providerId in the registry, no UI surface, no traffic. Operators who want plain API-key Anthropic stay on the `anthropic` provider in `core-providers`.

## Enabling

Append the specifier to your `MODULES` env var:

```
MODULES=oidc,webhooks,core-providers,@appstrate/module-claude-code
```

The platform resolves it via dynamic import — workspace resolution finds it locally during development; in production it must be installed (it ships as a workspace package and is bundled by the build).

## What it contributes

- `modelProviders()` → one `ModelProviderDefinition` with `providerId: "claude-code"`, `apiShape: "anthropic-messages"`, OAuth metadata pointing at `claude.ai`/`platform.claude.com`, and the `oauthWireFormat` block (identity headers, third-party-tier system prelude, long-context adaptive retry) the Claude Code CLI sends on every authenticated `/v1/messages` request.

The provider declares no `hooks` — Anthropic OAuth tokens are not JWTs, so there is nothing for `extractTokenIdentity` to decode (the CLI surfaces `email` / `subscriptionType` from the token endpoint response body). The wire-format quirks live declaratively on `oauthWireFormat` and the sidecar applies them generically.

No DB tables, no routes, no workers — the unified `model_provider_credentials` table in core holds the OAuth blob.

## Client-side helper

The OAuth dance must run on the user's machine — Anthropic's authorize endpoint only allowlists loopback redirect URIs. Appstrate ships [`@appstrate/connect-helper`](https://www.npmjs.com/package/@appstrate/connect-helper) for this purpose; the dashboard mints a pairing token and surfaces `npx @appstrate/connect-helper@latest <token>`. The helper binds `127.0.0.1:53692`, completes the PKCE flow, and POSTs the resulting credentials back to the platform.

The helper's source lives in a separate private repo (`appstrate/connect-helper`) — the published npm package is public so `npx` works without auth. The helper's `PROVIDERS` table already registers `"claude-code"`; no setup is required from the operator beyond enabling this module on the platform side.

## Authoring follow-on OAuth providers

Together with [`@appstrate/module-codex`](../module-codex/README.md), this module is one of the two canonical OAuth-provider examples. Copy the shape: declare a `ModelProviderDefinition` with `authMode: "oauth2"`, provide `hooks` if the access token needs to be decoded for an identity claim (Codex does, Claude Code doesn't), and pin any wire-format quirks in `oauthWireFormat`. The client-side helper (`@appstrate/connect-helper`) registers each provider by canonical `providerId` in its own `MODEL_PROVIDERS` table — extending it requires a coordinated bump.
