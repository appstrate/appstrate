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

import {
  CLAUDE_CODE_IDENTITY_HEADERS,
  CLAUDE_CODE_IDENTITY_PROMPT,
} from "@appstrate/core/sidecar-types";
import type { CachedToken } from "./oauth-token-cache.ts";
import { MAX_REQUEST_BODY_SIZE } from "./helpers.ts";

/**
 * Thrown by {@link transformBody} when the buffered LLM request body
 * exceeds {@link MAX_REQUEST_BODY_SIZE}. Caller should map to a 413.
 */
export class TransformBodyTooLargeError extends Error {
  constructor(
    public readonly actualBytes: number,
    public readonly limitBytes: number,
  ) {
    super(
      `LLM request body of ${actualBytes} bytes exceeds the per-request limit of ${limitBytes} bytes (raise via SIDECAR_MAX_REQUEST_BODY_BYTES).`,
    );
    this.name = "TransformBodyTooLargeError";
  }
}

/**
 * Provider identity headers. Returns hop-by-hop-safe lower-cased keys —
 * caller is responsible for ensuring these aren't filtered out by
 * downstream `filterHeaders()` calls.
 */
export function buildIdentityHeaders(
  providerId: string,
  token: CachedToken,
): Record<string, string> {
  switch (providerId) {
    case "claude-code":
      return {
        accept: "application/json",
        ...CLAUDE_CODE_IDENTITY_HEADERS,
      };

    case "codex": {
      // Codex traffic is fronted by Cloudflare which bot-mitigates any
      // request whose `User-Agent` doesn't look like an approved client.
      // The agent's openai-responses provider goes through the OpenAI
      // SDK which sets `User-Agent: OpenAI/JS …` — that triggers
      // `cf-mitigated: challenge` → HTML 403. Force the same UA pi-ai's
      // openai-codex-responses provider uses (verified to pass WAF), and
      // keep `originator: pi` consistent with it.
      const headers: Record<string, string> = {
        originator: "pi",
        "openai-beta": "responses=experimental",
        "user-agent": "pi (linux x86_64)",
        accept: "text/event-stream",
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
 *
 * The `/llm/*` route does NOT share the MCP envelope cap enforced inside
 * `mcp.ts` (that one only governs `provider_call`'s base64-decoded body),
 * so we gate buffered LLM bodies explicitly here against the same
 * {@link MAX_REQUEST_BODY_SIZE} (configurable via `SIDECAR_MAX_REQUEST_BODY_BYTES`,
 * default 10 MB). Refusing oversized payloads early prevents the parse +
 * restringify round-trip from amplifying memory pressure on legitimate
 * LLM traffic, and guarantees a loud, structured failure rather than
 * silent slow-downs.
 */
export function transformBody(
  providerId: string,
  bodyText: string,
  options: { forceStream?: boolean; forceStore?: boolean } = {},
): string {
  if (!bodyText) return bodyText;

  const byteLength = new TextEncoder().encode(bodyText).byteLength;
  if (byteLength > MAX_REQUEST_BODY_SIZE) {
    throw new TransformBodyTooLargeError(byteLength, MAX_REQUEST_BODY_SIZE);
  }

  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    // Not JSON — pass through (defensive; LLM endpoints always JSON).
    return bodyText;
  }
  if (!isPlainObject(json)) return bodyText;

  switch (providerId) {
    case "claude-code":
      return JSON.stringify(applyClaudeIdentityPrepend(json));
    case "codex":
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
  const identityBlock: ClaudeTextBlock = { type: "text", text: CLAUDE_CODE_IDENTITY_PROMPT };

  const system = json.system;
  if (Array.isArray(system)) {
    const first = system[0] as ClaudeTextBlock | undefined;
    const alreadyPrepended = first?.type === "text" && first.text === CLAUDE_CODE_IDENTITY_PROMPT;
    json.system = alreadyPrepended ? system : [identityBlock, ...system];
  } else if (typeof system === "string") {
    json.system =
      system === CLAUDE_CODE_IDENTITY_PROMPT
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
