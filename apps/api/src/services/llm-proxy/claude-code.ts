// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Code (Claude Pro/Max/Team subscription) adapter for
 * `/api/llm-proxy/claude-code-messages/*` — FIRST-PARTY-ONLY.
 *
 * Same policy as codex: a personal subscription is never spendable through
 * an API key or external token; the org's own interactive surfaces
 * (dashboard JWT, in-process chat loopback) may, which is the trust
 * boundary the in-container sidecar already crosses to serve these
 * credentials to runs.
 *
 * Wire format split (single source of truth = the claude-code module's
 * `oauthWireFormat`, applied generically in `core.ts`):
 *   - identity headers (`accept`, `anthropic-dangerous-direct-browser-
 *     access`, `x-app: cli`) and the system prelude ("You are Claude
 *     Code, …", which the third-party-tier filter requires verbatim) are
 *     applied from the registry in core.ts.
 *
 * What this adapter adds is the part the module deliberately leaves to the
 * runtime (the in-container Pi-AI normally supplies it, so the proxy must
 * stand in for the CLI here):
 *   - `Authorization: Bearer <oauth token>` (NOT `x-api-key`);
 *   - `anthropic-beta: oauth-2025-04-20` — authorizes the OAuth token on
 *     `/v1/messages` — merged with any beta tokens the caller sent
 *     (prompt-caching, extended-thinking…);
 *   - `anthropic-version` (defaulted) and a `claude-cli` user-agent (the
 *     subscription backend bot-mitigates non-CLI agents, like Codex).
 *
 * Usage parsing is identical to the API-key Anthropic shape — delegated to
 * {@link anthropicMessagesAdapter}.
 */

import type { LlmProxyAdapter } from "./types.ts";
import { anthropicMessagesAdapter } from "./anthropic.ts";

/** The beta token that authorizes an OAuth subscription token on /v1/messages. */
const OAUTH_BETA = "oauth-2025-04-20";

function readForwardedHeader(incoming: Headers, name: string): string | null {
  for (const [k, v] of incoming) {
    if (k.toLowerCase() === name) return v;
  }
  return null;
}

export const claudeCodeMessagesAdapter: LlmProxyAdapter = {
  apiShape: "anthropic-messages",

  buildUpstreamHeaders(incoming, apiKey) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "user-agent": "claude-cli/1.0.0 (external, appstrate)",
    };

    // Merge the OAuth beta token with whatever betas the caller sent
    // (caching/thinking), de-duplicated.
    const callerBeta = readForwardedHeader(incoming, "anthropic-beta");
    const betas = new Set(
      (callerBeta ? callerBeta.split(",") : []).map((s) => s.trim()).filter(Boolean),
    );
    betas.add(OAUTH_BETA);
    headers["anthropic-beta"] = [...betas].join(",");

    headers["anthropic-version"] =
      readForwardedHeader(incoming, "anthropic-version") ?? "2023-06-01";
    return headers;
  },

  parseJsonUsage: anthropicMessagesAdapter.parseJsonUsage,
  parseSseUsage: anthropicMessagesAdapter.parseSseUsage,
};
