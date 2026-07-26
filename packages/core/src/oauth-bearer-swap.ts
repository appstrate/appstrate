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
 *
 * The placeholder side of that swap lives here too
 * ({@link ANTHROPIC_OAUTH_PLACEHOLDER_API_KEY}) so the producers that mint it
 * and the swap that consumes it agree on one literal.
 */

/**
 * The placeholder `apiKey` handed to pi-ai for an **Anthropic OAuth
 * subscription** binding, on every path where the real token is swapped in
 * later (the run path's sidecar `/llm` branch, and the CLI's llm-proxy preset
 * path).
 *
 * Why the exact string matters: pi-ai's `anthropic-messages` provider selects
 * the OAuth request shape from the key alone —
 * `apiKey.includes("sk-ant-oat")`
 * (`@mariozechner/pi-ai` `dist/providers/anthropic.js`). Anthropic gates OAuth
 * tokens to that body shape upstream, so the reshape has to happen client-side,
 * before the placeholder is swapped for the real bearer. A placeholder missing
 * the marker silently drops the request onto the api-key shape and the upstream
 * rejects it.
 *
 * The value mirrors the real token prefix (`sk-ant-oat01-…`) so shape detection
 * is byte-for-byte what a genuine subscription token would trigger, and it is
 * deliberately fixed — never derived from the real token — so the emitted shape
 * can't become token-dependent. It is a placeholder, not a credential: it is
 * never spendable and never leaves the platform.
 */
export const ANTHROPIC_OAUTH_PLACEHOLDER_API_KEY = "sk-ant-oat01-placeholder";

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
