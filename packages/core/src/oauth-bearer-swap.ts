// SPDX-License-Identifier: Apache-2.0

/**
 * Provider-neutral OAuth bearer-swap — the sidecar `/llm` oauth branch's only
 * header policy.
 *
 * An OAuth-subscription run hands the agent container a placeholder bearer; the
 * real subscription token never crosses the isolation boundary. The sidecar
 * resolves the real token platform-side and swaps it onto the outbound request.
 * The Pi SDK (`@mariozechner/pi-ai`) already emits the full subscription request
 * shape — the Anthropic OAuth fingerprint (`anthropic-beta: oauth-2025-04-20`,
 * the `claude-cli` user-agent, the "You are Claude Code" system prelude) or the
 * codex-responses shape (`chatgpt-account-id`, the codex user-agent). So the
 * sidecar forges NOTHING: it only replaces the placeholder bearer with the real
 * one and drops any stray `x-api-key`. Every other header the SDK signed is
 * forwarded verbatim.
 *
 * Pure: no credential lookup, no I/O. The caller owns SSRF checks, credential
 * resolution, and the surrounding header stripping
 * (host/content-length/hop-by-hop).
 */

/**
 * Apply the bearer-swap policy to a {@link Headers} in place and return it:
 * force the real subscription bearer onto `authorization` and drop any client
 * `x-api-key` (these paths are bearer-only). Provider-neutral — it touches no
 * provider-specific header, so the SDK's own fingerprint (user-agent,
 * anthropic-beta, chatgpt-account-id, …) rides through unchanged.
 */
export function applyOauthBearerSwap(headers: Headers, accessToken: string): Headers {
  // Bearer-only: never let a caller-supplied api-key ride along upstream.
  headers.delete("x-api-key");
  // Force the real subscription bearer, overwriting the placeholder bearer the
  // SDK signed the request with. `set` replaces any existing (case-insensitive)
  // authorization entry.
  headers.set("authorization", `Bearer ${accessToken}`);
  return headers;
}
