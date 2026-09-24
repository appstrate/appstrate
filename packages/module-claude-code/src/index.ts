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
 * calls to validate a credential or discover models. Both `claude-code` runs
 * and the chat execute on the single generic Pi engine
 * (`@earendil-works/pi-coding-agent` / `pi-ai`) — pi-ai emits the Anthropic OAuth
 * request shape natively from the token, including the `oauth-2025-04-20` beta
 * header; the sidecar (run) / in-process token resolution (chat) only swap the
 * bearer and add or modify no `anthropic-beta` header.
 * The provider declares no `oauthWireFormat`; the module's only `hooks`
 * entry is `validateCredential`, an OFFLINE check (no network) that confirms
 * the bearer is well-formed and unexpired — its presence is what makes
 * credential validation offline. Model discovery neither probes nor persists:
 * `modelDiscovery: { mode: "static" }` makes the served set the provider's
 * offer (Pi's `anthropic` records), resolved on every read. Real per-model
 * availability is validated at the first agent run (on the Pi engine). See
 * `docs/architecture/SUBSCRIPTION_COMPLIANCE.md`.
 */

import type {
  AppstrateModule,
  CredentialValidationContext,
  CredentialValidationResult,
  ModelProviderDefinition,
  ModelProviderHooks,
} from "@appstrate/core/module";
import { validateOfflineExpiry } from "@appstrate/core/module";
import { ANTHROPIC_OAUTH_PLACEHOLDER_API_KEY } from "@appstrate/core/oauth-bearer-swap";

const claudeCodeHooks: ModelProviderHooks = {
  /**
   * Build the `MODEL_API_KEY` placeholder the agent container sees on the RUN
   * path. pi-ai's `anthropic-messages` provider selects the OAuth request shape
   * IFF the key string contains `sk-ant-oat`, so the placeholder must contain it
   * deterministically — regardless of the real subscription token's prefix — or
   * the run's OAuth-shape detection becomes token-dependent. The real token is
   * swapped in by the sidecar gateway server-side; this placeholder never leaves
   * the platform as a spendable credential. Returns a fixed string (the access
   * token is intentionally ignored — the shape must not depend on it).
   */
  buildApiKeyPlaceholder(): string {
    return ANTHROPIC_OAUTH_PLACEHOLDER_API_KEY;
  },
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
   * and true credential liveness are established at the first agent run
   * (on the Pi engine), which presents the credential to the real
   * backend.
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
    // `expiresAt` is the ONLY expiry source. The shared gate rejects an
    // absent expiry (a dead token with no expiry metadata must not pass) and
    // a past expiry.
    return validateOfflineExpiry(ctx.expiresAt);
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
    // Must match pi-ai's /authorize scopes (pinned by the pi-ai-oauth-parity test).
    scopes: [
      "org:create_api_key",
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
      "user:file_upload",
    ],
    pkce: "S256",
  },
  // A model the plan does not serve (Pro/Max/Team differ) fails at first run.
  catalogProviderId: "anthropic",
  // One current model per family, bumped with Pi.
  featuredModels: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5-1"],
  modelDiscovery: { mode: "static" },
  // Anthropic OAuth tokens are not JWTs — no JWT identity decoding. There is no
  // fingerprint forging: both `claude-code` agent runs and the interactive chat
  // execute on the single generic Pi engine (`@earendil-works/pi-coding-agent` /
  // `pi-ai`), which emits the Anthropic OAuth request shape natively from a
  // token containing `sk-ant-oat` — the sidecar (run) / in-process token
  // resolution (chat) only supplies the real bearer server-side. The provider
  // contributes ONLY this declarative definition; the chat surface is owned by
  // the generic `@appstrate/module-chat` engine (no per-provider chat handler,
  // no run-engine binding).
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
    // Declarative only — the registry pulls the provider from modelProviders()
    // at boot. Both agent runs and chat run on the generic Pi engine; this
    // module contributes no chat handler and no run-engine binding.
  },

  modelProviders() {
    return [claudeCodeProvider];
  },
};

export default claudeCodeModule;
