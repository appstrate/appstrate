// SPDX-License-Identifier: Apache-2.0

/**
 * Provider-specific identity injection for the OAuth `/llm/*` path.
 *
 * Two responsibilities (cf. SPEC §5.4–5.6):
 *
 *   - {@link buildIdentityHeaders}: returns the static identity headers
 *     each provider expects when the upstream is hit with an OAuth
 *     subscription token (Codex/Claude). The agent (Pi-AI) cannot be
 *     trusted to set these — they are part of what makes the provider
 *     accept a subscription-bearing call. Forced server-side.
 *   - {@link transformBody}: rewrites the agent-supplied JSON body to
 *     prepend the Claude Code identity prelude (Anthropic) or coerce
 *     stream/store flags (Codex). Buffered transform — we trade the
 *     streaming upload for correctness; LLM payloads typically stay
 *     well under the sidecar's 10 MB request cap.
 */

import type { CachedToken } from "./oauth-token-cache.ts";

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Provider identity headers. Returns hop-by-hop-safe lower-cased keys —
 * caller is responsible for ensuring these aren't filtered out by
 * downstream `filterHeaders()` calls.
 */
export function buildIdentityHeaders(
  providerPackageId: string,
  token: CachedToken,
): Record<string, string> {
  switch (providerPackageId) {
    case "@appstrate/provider-claude-code":
      return {
        accept: "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
        "x-app": "cli",
      };

    case "@appstrate/provider-codex": {
      const headers: Record<string, string> = {
        originator: "codex_cli_rs",
        "openai-beta": "responses=experimental",
      };
      if (token.accountId) headers["chatgpt-account-id"] = token.accountId;
      return headers;
    }

    default:
      return {};
  }
}

/**
 * Apply per-provider request body transforms. Pure function over JSON
 * text — the caller has already buffered the body (the OAuth path is
 * incompatible with streaming uploads anyway).
 *
 * Returns the same input unchanged when no transform is needed.
 */
export function transformBody(
  providerPackageId: string,
  bodyText: string,
  options: { forceStream?: boolean; forceStore?: boolean } = {},
): string {
  if (!bodyText) return bodyText;

  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    // Not JSON — pass through (defensive; LLM endpoints always JSON).
    return bodyText;
  }
  if (!isPlainObject(json)) return bodyText;

  switch (providerPackageId) {
    case "@appstrate/provider-claude-code":
      return JSON.stringify(applyClaudeIdentityPrepend(json));
    case "@appstrate/provider-codex":
      return JSON.stringify(applyCodexCoercion(json, options));
    default:
      return bodyText;
  }
}

interface ClaudeTextBlock {
  type: "text";
  text: string;
}

function applyClaudeIdentityPrepend(json: Record<string, unknown>): Record<string, unknown> {
  const identityBlock: ClaudeTextBlock = { type: "text", text: CLAUDE_CODE_IDENTITY };

  const system = json.system;
  if (Array.isArray(system)) {
    const first = system[0] as ClaudeTextBlock | undefined;
    const alreadyPrepended = first?.type === "text" && first.text === CLAUDE_CODE_IDENTITY;
    json.system = alreadyPrepended ? system : [identityBlock, ...system];
  } else if (typeof system === "string") {
    json.system =
      system === CLAUDE_CODE_IDENTITY
        ? [identityBlock]
        : [identityBlock, { type: "text", text: system }];
  } else {
    json.system = [identityBlock];
  }

  return json;
}

function applyCodexCoercion(
  json: Record<string, unknown>,
  options: { forceStream?: boolean; forceStore?: boolean },
): Record<string, unknown> {
  if (options.forceStream !== undefined) json.stream = options.forceStream;
  if (options.forceStore !== undefined) json.store = options.forceStore;
  return json;
}

/**
 * Adaptive Anthropic beta exclusion (SPEC §5.6). When the provider
 * returns an "out of extra usage" / "long context beta not available"
 * 400, retry once with the `context-1m-2025-08-07` beta token stripped
 * from the `anthropic-beta` header.
 *
 * Returns:
 *   - a {@link AdaptiveBetaResult} with the rewritten headers when an
 *     adaptive retry is warranted,
 *   - `null` when the response shouldn't trigger one (status mismatch,
 *     unknown body shape, header already free of the offending beta).
 *
 * Pure function — does not mutate inputs.
 */
const LONG_CONTEXT_BETA = "context-1m-2025-08-07";
const ADAPTIVE_BETA_PATTERNS = [/out of extra usage/i, /long context beta not available/i];

export interface AdaptiveBetaResult {
  headers: Record<string, string>;
}

export function adaptBetaHeaderForRetry(
  status: number,
  responseBodyText: string,
  currentHeaders: Record<string, string>,
): AdaptiveBetaResult | null {
  if (status !== 400) return null;
  if (!ADAPTIVE_BETA_PATTERNS.some((re) => re.test(responseBodyText))) return null;

  const lowered: Record<string, string> = {};
  for (const [k, v] of Object.entries(currentHeaders)) {
    lowered[k.toLowerCase()] = v;
  }
  const beta = lowered["anthropic-beta"];
  if (!beta) return null;

  const tokens = beta
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!tokens.includes(LONG_CONTEXT_BETA)) return null;

  const filtered = tokens.filter((t) => t !== LONG_CONTEXT_BETA);
  const next: Record<string, string> = { ...currentHeaders };
  // Find the original-cased key (case-insensitive lookup) and overwrite.
  let originalKey = "anthropic-beta";
  for (const k of Object.keys(currentHeaders)) {
    if (k.toLowerCase() === "anthropic-beta") {
      originalKey = k;
      break;
    }
  }
  if (filtered.length === 0) {
    delete next[originalKey];
  } else {
    next[originalKey] = filtered.join(", ");
  }
  return { headers: next };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
