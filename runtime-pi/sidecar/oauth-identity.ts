// SPDX-License-Identifier: Apache-2.0

/**
 * Provider-agnostic wire-format application for the OAuth `/llm/*` path.
 *
 * The sidecar never branches on `providerId`. It reads the declarative
 * {@link OAuthWireFormat} contract from `LlmProxyOauthConfig.wireFormat`
 * (populated at boot by the platform from each module's
 * `ModelProviderDefinition.oauthWireFormat`) and applies three things:
 *
 *   - {@link buildIdentityHeaders}: static fingerprint headers + optional
 *     `accountId` echo. The agent (Pi-AI) cannot be trusted to set
 *     these — they are part of what makes the provider accept a
 *     subscription-bearing call. Forced server-side.
 *   - {@link transformBody}: rewrites the agent-supplied JSON body to
 *     prepend a system prelude or coerce stream/store flags. Buffered
 *     transform — we trade the streaming upload for correctness; LLM
 *     payloads typically stay well under the sidecar's 10 MB request
 *     cap.
 *   - {@link adaptHeaderForRetry}: when an upstream returns a known
 *     status + body pattern, strip a header token and retry once
 *     (e.g. a long-context beta fallback).
 *
 * When `wireFormat` is undefined, all three are no-ops. Add a new OAuth
 * provider by populating `oauthWireFormat` on the module's
 * `ModelProviderDefinition` — no sidecar code changes.
 */

import type { OAuthWireFormat, OAuthAdaptiveRetryPolicy } from "@appstrate/core/sidecar-types";
import {
  buildIdentityHeaders as coreBuildIdentityHeaders,
  applyOAuthBodyTransform,
} from "@appstrate/core/oauth-wire-format";
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
 *
 * When `wireFormat` is undefined or carries no identity fields, returns
 * an empty object (the agent's own headers still flow through).
 */
export function buildIdentityHeaders(
  wireFormat: OAuthWireFormat | undefined,
  token: CachedToken,
): Record<string, string> {
  // Single source of truth shared with the first-party LLM proxy.
  return coreBuildIdentityHeaders(wireFormat, token.accountId);
}

/**
 * Apply per-provider request body transforms. Pure function over JSON
 * text — the caller has already buffered the body (the OAuth path is
 * incompatible with streaming uploads anyway).
 *
 * Returns the same input unchanged when `wireFormat` carries no body-level
 * transform (no `systemPrepend`, no `forceStream`, no `forceStore`).
 *
 * The `/llm/*` route does NOT share the MCP envelope cap enforced inside
 * `mcp.ts` (that one only governs `api_call`'s base64-decoded body),
 * so we gate buffered LLM bodies explicitly here against the same
 * {@link MAX_REQUEST_BODY_SIZE} (configurable via `SIDECAR_MAX_REQUEST_BODY_BYTES`,
 * default 10 MB). Refusing oversized payloads early prevents the parse +
 * restringify round-trip from amplifying memory pressure on legitimate
 * LLM traffic, and guarantees a loud, structured failure rather than
 * silent slow-downs.
 */
export function transformBody(wireFormat: OAuthWireFormat | undefined, bodyText: string): string {
  if (!bodyText) return bodyText;

  // Sidecar-only guard: the buffered LLM body has no MCP-envelope cap, so
  // bound it here before the parse + restringify round-trip.
  const byteLength = new TextEncoder().encode(bodyText).byteLength;
  if (byteLength > MAX_REQUEST_BODY_SIZE) {
    throw new TransformBodyTooLargeError(byteLength, MAX_REQUEST_BODY_SIZE);
  }

  // The transform itself is the single source of truth shared with the
  // first-party LLM proxy (`@appstrate/core/oauth-wire-format`).
  return applyOAuthBodyTransform(wireFormat, bodyText);
}

/**
 * Adaptive header retry (SPEC §5.6). When the provider returns the
 * configured `status` and the response body matches any of the policy's
 * `bodyPatterns`, strip `removeToken` from the comma-separated header
 * named `headerName` and let the caller replay the request once.
 *
 * Returns:
 *   - a {@link AdaptiveBetaResult} with the rewritten headers when an
 *     adaptive retry is warranted,
 *   - `null` when the response shouldn't trigger one (no policy, status
 *     mismatch, body pattern mismatch, header absent, or token not
 *     present in the header value).
 *
 * Pure function — does not mutate inputs.
 */
export interface AdaptiveBetaResult {
  headers: Record<string, string>;
}

export function adaptHeaderForRetry(
  policy: OAuthAdaptiveRetryPolicy | undefined,
  status: number,
  responseBodyText: string,
  currentHeaders: Record<string, string>,
): AdaptiveBetaResult | null {
  if (!policy) return null;
  if (status !== policy.status) return null;
  const matched = policy.bodyPatterns.some((p) => new RegExp(p, "i").test(responseBodyText));
  if (!matched) return null;

  const targetKey = policy.headerName.toLowerCase();
  let originalKey: string | null = null;
  for (const k of Object.keys(currentHeaders)) {
    if (k.toLowerCase() === targetKey) {
      originalKey = k;
      break;
    }
  }
  if (!originalKey) return null;

  const value = currentHeaders[originalKey] ?? "";
  const tokens = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!tokens.includes(policy.removeToken)) return null;

  const filtered = tokens.filter((t) => t !== policy.removeToken);
  const next: Record<string, string> = { ...currentHeaders };
  if (filtered.length === 0) {
    delete next[originalKey];
  } else {
    next[originalKey] = filtered.join(", ");
  }
  return { headers: next };
}
