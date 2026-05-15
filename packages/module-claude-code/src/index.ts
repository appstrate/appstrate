// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Code (Anthropic) module — OAuth model provider that lets an
 * operator connect their Claude Pro / Max / Team subscription via the
 * official Claude Code OAuth client_id and run agents against
 * `api.anthropic.com/v1/messages` with a bearer access token instead of
 * an API key.
 *
 * Why a dedicated module: Anthropic's Consumer Terms of Service
 * (https://www.anthropic.com/legal/consumer-terms) forbid using OAuth
 * subscription tokens with any third-party product, tool, or service —
 * including agentic SDKs. Operators who have reviewed the ToS posture
 * opt in deliberately by appending `@appstrate/module-claude-code` to
 * MODULES.
 *
 * When the module is not loaded the `claude-code` providerId is unknown
 * to the platform's registry — no credentials can be created, no sidecar
 * config carries `providerId="claude-code"`, and Anthropic OAuth traffic
 * is fully impossible end-to-end. Operators who want plain API-key
 * Anthropic stay on the `anthropic` provider in `core-providers`.
 *
 * Anthropic OAuth tokens are NOT JWTs — the CLI surfaces `email` /
 * `subscriptionType` from the token endpoint response body, not from a
 * self-describing access token, so this module ships no `hooks`. Every
 * Anthropic-specific wire-format quirk lives declaratively on the
 * provider's `oauthWireFormat` block (the sidecar applies it generically):
 *   - `identityHeaders` — reproduces the static
 *     `anthropic-dangerous-direct-browser-access: true` + `x-app: cli`
 *     pair the Claude Code CLI sends on every authenticated
 *     `/v1/messages` request.
 *   - `systemPrepend` — prepends the third-party-tier filter prelude
 *     ("You are Claude Code, …") to the request body's `system` field.
 *     Reproduced verbatim from `anthropic-ai/claude-code`'s
 *     `THIRD_PARTY_TIER_FILTER_PREFIX` — paraphrasing it (even
 *     capitalisation) trips Anthropic's third-party tier filter and
 *     silently 429s every request.
 *   - `adaptiveRetry` — when the upstream returns a 400 carrying "out of
 *     extra usage" or "long context beta not available", strip the
 *     `context-1m-2025-08-07` token from `anthropic-beta` and replay
 *     once. Lets the agent keep working when the long-context beta runs
 *     out without surfacing a fatal error to the user.
 *
 * The in-container Pi-AI runtime supplies its own `anthropic-beta`
 * (e.g. `claude-code-20250219,oauth-2025-04-20,…`) and `user-agent:
 * claude-cli/<v>`, so this module does NOT inject those.
 */

import type { AppstrateModule, ModelProviderDefinition } from "@appstrate/core/module";

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

const claudeCodeProvider: ModelProviderDefinition = {
  providerId: "claude-code",
  displayName: "Claude Code (Anthropic)",
  iconUrl: "anthropic",
  description:
    "Run agents against your Claude Pro / Max / Team subscription via the Claude Code OAuth client.",
  docsUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
  apiShape: "anthropic-messages",
  defaultBaseUrl: "https://api.anthropic.com",
  baseUrlOverridable: false,
  authMode: "oauth2",
  featured: true,
  oauth: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizationUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    refreshUrl: "https://platform.claude.com/v1/oauth/token",
    scopes: ["org:create_api_key", "user:profile", "user:inference"],
    pkce: "S256",
  },
  // Claude Code (Claude Pro/Max/Team subscription) authenticates against
  // the Anthropic catalog — metadata flows through anthropic.json.
  catalogProviderId: "anthropic",
  featuredModels: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"],
  // Anthropic OAuth tokens are not JWTs and the upstream `/v1/messages`
  // surface accepts the agent's declared body verbatim — no Codex-style
  // stream/store coercion, no JWT identity decoding, no inference probe.
  // Every Claude-Code-specific wire fingerprint lives below.
  oauthWireFormat: {
    // Static identity headers Anthropic enforces on every OAuth-authenticated
    // `/v1/messages` call. `accept`/`content-type` are NOT pinned — the agent
    // picks the right pair per request.
    identityHeaders: {
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli",
    },
    // System-prompt prelude Anthropic's third-party-tier filter requires.
    // Reproduced verbatim from `anthropic-ai/claude-code`'s
    // `THIRD_PARTY_TIER_FILTER_PREFIX`. Paraphrasing (even capitalisation)
    // trips the filter and silently 429s every request.
    systemPrepend: {
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    },
    adaptiveRetry: {
      status: 400,
      bodyPatterns: ["out of extra usage", "long context beta not available"],
      headerName: "anthropic-beta",
      removeToken: "context-1m-2025-08-07",
    },
  },
};

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

const claudeCodeModule: AppstrateModule = {
  manifest: {
    id: "claude-code",
    name: "Claude Code (Anthropic) OAuth Provider",
    version: "1.0.0",
  },

  async init() {
    // Declarative — registry pulls from modelProviders() at boot.
  },

  modelProviders() {
    return [claudeCodeProvider];
  },
};

export default claudeCodeModule;
