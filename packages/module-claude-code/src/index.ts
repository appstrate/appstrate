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
 * No fingerprint forging anywhere. A `claude-code` run executes on the official
 * Claude Agent SDK (the `claude` runner engine) and the chat on the same SDK —
 * the official `claude` binary signs its own client fingerprint, and the sidecar
 * / chat gateways only swap the bearer + ensure the `oauth-2025-04-20` beta. The
 * provider therefore declares no `oauthWireFormat`; the module's only `hooks`
 * entry is a minimal credential-validation / model-discovery probe that sends
 * just the bearer + version + oauth beta (no `x-app`, no `system` prelude).
 */

import type {
  AppstrateModule,
  InferenceProbeRequest,
  ModelProviderDefinition,
  ModelProviderHooks,
} from "@appstrate/core/module";

/**
 * 1-token `/v1/messages` probe to validate a subscription credential and
 * discover which models the plan serves (`available_model_ids`). Sends ONLY the
 * OAuth bearer (NOT `x-api-key` — the generic anthropic-messages test would send
 * the wrong header for a subscription token), the `anthropic-version`, and the
 * `oauth-2025-04-20` beta the OAuth token requires.
 *
 * It does NOT forge the Claude Code client fingerprint — no `x-app: cli`, no
 * `anthropic-dangerous-direct-browser-access`, no third-party-tier `system`
 * prelude. Forging is removed platform-wide: real inference runs on the official
 * Claude Agent SDK binary (which signs its own fingerprint), and this probe is
 * a plain authenticated request. A model the probe can't reach is simply dropped
 * from `available_model_ids`.
 */
function buildClaudeCodeInferenceRequest(config: {
  baseUrl: string;
  modelId: string;
  apiKey: string;
}): InferenceProbeRequest {
  return {
    url: `${config.baseUrl.replace(/\/+$/, "")}/v1/messages`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.modelId,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
  };
}

const claudeCodeHooks: ModelProviderHooks = {
  buildInferenceProbe(ctx) {
    return buildClaudeCodeInferenceRequest({
      baseUrl: ctx.baseUrl,
      modelId: ctx.modelId,
      apiKey: ctx.apiKey,
    });
  },
};

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
  // Probed against the live credential after import (and on manual
  // refresh) — what THIS account's plan actually serves (Pro vs Max vs
  // Team differ, e.g. Opus/Fable access) lands on the credential's
  // `available_model_ids`. No machine-readable source describes the
  // Claude subscription tiers, so this superset is curated from
  // anthropic.json's current generation; the probe sorts out the rest.
  modelDiscoveryCandidates: [
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
  ],
  // Anthropic OAuth tokens are not JWTs — no JWT identity decoding. There is no
  // sidecar fingerprint forging: a `claude-code` run executes on the official
  // Claude Agent SDK (the `claude` runner engine), whose binary signs its own
  // client fingerprint. The sidecar's OAuth mode only swaps the bearer + ensures
  // the OAuth beta — see `runtime-pi/sidecar/app.ts` and `engine-select.ts`.
  hooks: claudeCodeHooks,
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
