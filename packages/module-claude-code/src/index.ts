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
 * No fingerprint forging anywhere — and the platform issues ZERO Anthropic API
 * calls to validate a credential or discover models. A `claude-code` run
 * executes on the official Claude Agent SDK (the `claude` runner engine) and the
 * chat on the same SDK — the official `claude` binary signs its own client
 * fingerprint, and the sidecar / chat gateways only swap the bearer + ensure the
 * `oauth-2025-04-20` beta. The provider declares no `oauthWireFormat`; the
 * module's only `hooks` entry is `validateCredential`, an OFFLINE check (no
 * network) that confirms the bearer is well-formed and unexpired — its
 * presence is what makes credential validation offline. Model discovery
 * persists the static `modelDiscoveryCandidates` (declared via `modelDiscovery:
 * { mode: "static" }`) without probing — real per-model availability is
 * validated at first official-binary run. See
 * `docs/architecture/SUBSCRIPTION_COMPLIANCE.md`.
 */

import type {
  AppstrateModule,
  CredentialValidationContext,
  CredentialValidationResult,
  ModelProviderDefinition,
  ModelProviderHooks,
} from "@appstrate/core/module";
import { runClaudeAgentChat } from "./claude-agent/engine.ts";

const claudeCodeHooks: ModelProviderHooks = {
  /**
   * Validate a Claude subscription credential OFFLINE — NO request to
   * api.anthropic.com. Anthropic OAuth tokens are NOT JWTs (no decodable
   * identity/expiry claims), so the only expiry source is the credential
   * row's `expiresAt`. Structural validation is: the bearer is a
   * non-empty string AND the row carries an unexpired `expiresAt`. When
   * `expiresAt` is absent, expiry is unverifiable offline and the
   * credential is rejected — a dead token with no expiry metadata must
   * not pass. This is a STRUCTURAL/offline check only, NOT a signature
   * verification or a live backend call. The platform never spends a
   * subscription request to test a token — real per-model availability
   * and true credential liveness are established at first
   * official-binary run.
   */
  validateCredential(ctx: CredentialValidationContext): CredentialValidationResult {
    if (typeof ctx.apiKey !== "string" || ctx.apiKey.trim().length === 0) {
      return {
        ok: false,
        error: "AUTH_FAILED",
        message: "Missing or malformed Claude subscription bearer token",
      };
    }
    // Anthropic OAuth tokens are opaque (not JWTs), so the credential row's
    // `expiresAt` is the ONLY expiry source. When it's absent, expiry is
    // unverifiable offline — a dead token with no expiry metadata would
    // otherwise pass, so reject rather than silently accept.
    if (ctx.expiresAt === undefined || ctx.expiresAt === null) {
      return {
        ok: false,
        error: "AUTH_FAILED",
        message: "credential expiry could not be verified",
      };
    }
    if (ctx.expiresAt <= Date.now()) {
      return {
        ok: false,
        error: "AUTH_FAILED",
        message: "Claude subscription token has expired — reconnect the subscription",
      };
    }
    return { ok: true };
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
  // OFFLINE validation: the platform issues ZERO Anthropic API calls to test a
  // credential or discover models. The connection test runs the
  // `validateCredential` hook below (a non-empty/unexpired bearer check) — its
  // mere presence is what tells the platform to validate offline. Static
  // discovery persists the candidates below (∩ catalog) without per-model
  // probing. Real availability is checked at first official-binary run.
  // Persisted as-is (∩ catalog) — what THIS account's plan actually serves
  // (Pro vs Max vs Team differ, e.g. Opus/Fable access) lands on the
  // credential's `available_model_ids`. No machine-readable source describes
  // the Claude subscription tiers, so this superset is curated from
  // anthropic.json's current generation.
  modelDiscoveryCandidates: [
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
  ],
  // Static discovery: persist the candidates above (∩ catalog) without probing.
  modelDiscovery: { mode: "static" },
  // Anthropic OAuth tokens are not JWTs — no JWT identity decoding. There is no
  // sidecar fingerprint forging: a `claude-code` run executes on the official
  // Claude Agent SDK (the `claude` runner engine), whose binary signs its own
  // client fingerprint. The sidecar's OAuth mode only swaps the bearer + ensures
  // the OAuth beta — see `runtime-pi/sidecar/app.ts` and `subscription-run-policy.ts`.
  //
  // RUN-ONLY engine binding, read off this definition by the platform's
  // model-provider registry helpers (run-launcher + gateways resolve the engine
  // by provider id off this one registration). Runs execute on the Claude Agent
  // SDK (official binary, no forging) — the sidecar `/llm` gateway swaps the
  // bearer server-side, so the real token never enters the container. The
  // `claude` engine emits the structured deliverable natively via `outputFormat`
  // → `structured_output`, so the launcher does NOT offer it the MCP `output`
  // tool. The interactive chat driver is registered separately, through the
  // platform contract (`ctx.services.registerChatHandler` in `init()` below) —
  // NOT on this binding — so the run-engine binding never carries a chat surface
  // and no module imports another.
  subscriptionEngine: {
    engine: "claude",
  },
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

  async init(ctx) {
    // The provider definition (engine routing) is declarative — the registry
    // pulls it from modelProviders() at boot. The interactive chat driver is
    // contributed here through the PLATFORM CONTRACT (`ctx.services`), keyed by
    // provider id, so it lives entirely off the published-core run-engine
    // binding, requires no import of the chat module (module isolation), and
    // vanishes with this module when it is not loaded.
    ctx.services.registerChatHandler("claude-code", runClaudeAgentChat);
  },

  modelProviders() {
    return [claudeCodeProvider];
  },
};

export default claudeCodeModule;
