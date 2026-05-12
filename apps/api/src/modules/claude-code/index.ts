// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Code (Anthropic) module — OAuth model provider that lets an
 * operator connect their Claude Pro / Max / Team subscription via the
 * official Claude Code OAuth client_id.
 *
 * Why a dedicated module: Anthropic's Consumer ToS forbids using OAuth
 * subscription tokens with any third-party product, tool, or service —
 * including the Agent SDK. The OSS default therefore excludes
 * `claude-code`; operators who reviewed the ToS posture opt in
 * deliberately by appending `claude-code` to `MODULES`. When the module
 * is absent the provider id is unknown to the registry — no credentials
 * can be created, no sidecar config carries `providerId="claude-code"`,
 * and the sidecar's wire-format branch for that id is dead code.
 *
 * Wire-format specifics (sidecar handles these for the agent path):
 *   - identity headers (`anthropic-dangerous-direct-browser-access`,
 *     `x-app: cli`) are injected by
 *     `runtime-pi/sidecar/oauth-identity.ts` via the `claude-code` switch
 *     branch — constants live in `@appstrate/core/sidecar-types` so the
 *     sidecar build doesn't depend on this optional module.
 *   - the Claude-Code identity system-prompt prelude
 *     (`CLAUDE_CODE_IDENTITY_PROMPT`) is prepended to every outbound
 *     `/v1/messages` body by the same sidecar branch.
 *   - the in-container Pi-AI runtime supplies its own `anthropic-beta`
 *     (e.g. `claude-code-20250219,oauth-2025-04-20,…`) and `user-agent:
 *     claude-cli/<v>`, so the sidecar does NOT inject those.
 *
 * The provider definition declares no hooks because Anthropic OAuth
 * tokens are NOT JWTs (the CLI surfaces `email` / `subscriptionType`
 * from the token endpoint response body, not from a self-describing
 * access token), and the wire-format quirks listed above are handled
 * declaratively by the sidecar's `claude-code` branch.
 */

import type { AppstrateModule, ModelProviderDefinition } from "@appstrate/core/module";

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
  oauth: {
    // `platform.claude.com` is the canonical token host (cf.
    // `@mariozechner/pi-ai/utils/oauth/anthropic.js`). An earlier iteration
    // pointed at `claude.ai/v1/oauth/token` which appears reachable but
    // returns a non-canonical schema, breaking refresh.
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizationUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    refreshUrl: "https://platform.claude.com/v1/oauth/token",
    scopes: ["org:create_api_key", "user:profile", "user:inference"],
    pkce: "S256",
  },
  models: [
    {
      id: "claude-opus-4-7",
      contextWindow: 1000000,
      capabilities: ["text", "image", "reasoning", "long-context-1m"],
      recommended: true,
    },
    {
      id: "claude-sonnet-4-6",
      contextWindow: 1000000,
      capabilities: ["text", "image", "reasoning", "long-context-1m"],
      recommended: true,
    },
    {
      id: "claude-haiku-4-5",
      contextWindow: 200000,
      capabilities: ["text", "image"],
    },
  ],
};

const claudeCodeModule: AppstrateModule = {
  manifest: {
    id: "claude-code",
    name: "Claude Code (Anthropic) OAuth Provider",
    version: "1.0.0",
  },

  async init() {},

  modelProviders() {
    return [claudeCodeProvider];
  },
};

export default claudeCodeModule;
