// SPDX-License-Identifier: Apache-2.0

/**
 * Shared Anthropic OAuth-subscription **gateway policy** — the pure, provider-
 * neutral pieces of the "no-forge" request policy that both Claude OAuth
 * gateways must apply identically:
 *
 *   - the chat-side **SDK gateway** (`apps/api/.../claude-code-sdk-gateway.ts`)
 *   - the run-side **sidecar `/llm` oauth branch** (`runtime-pi/sidecar/app.ts`)
 *
 * The two gateways stay SEPARATE (different metering / trust boundary), but the
 * security-sensitive Anthropic request policy is identical and lives here so it
 * cannot drift between them:
 *
 *   - merge the `oauth-2025-04-20` beta into `anthropic-beta` WITHOUT dropping
 *     the official binary's own betas (order-preserving, idempotent);
 *   - force the real subscription bearer onto `authorization`;
 *   - drop any client `x-api-key` (these paths are bearer-only);
 *   - preserve the official-binary fingerprint headers (user-agent, x-app,
 *     anthropic-version, the driver's own betas) — we add the OAuth beta and
 *     swap the bearer, and forge NOTHING else.
 *
 * Pure: no credential lookup, no metering, no I/O. Each gateway keeps its own
 * SSRF (`isBlockedUrl`) check, credential resolution, and non-2xx scrub/log
 * around these primitives.
 */

/** Beta token that authorizes an OAuth subscription token on `/v1/messages`. */
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

/**
 * Merge a beta flag into a comma-separated `anthropic-beta` header without
 * dropping the driver's own betas (e.g. the Agent SDK's context/feature flags).
 * Order-preserving and idempotent; defaults to {@link ANTHROPIC_OAUTH_BETA}.
 */
export function mergeAnthropicBeta(
  existing: string | null | undefined,
  beta: string = ANTHROPIC_OAUTH_BETA,
): string {
  const parts = (existing ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.includes(beta)) parts.push(beta);
  return parts.join(",");
}

/**
 * Apply the shared Anthropic OAuth-gateway header policy to a {@link Headers}
 * in place and return it: force the real bearer, drop any `x-api-key`, and
 * merge the OAuth beta while preserving the official binary's own fingerprint
 * headers. This is the byte-identical "add OAuth beta only, preserve official
 * headers, never forge" core both gateways share. Pure — the caller owns the
 * surrounding header stripping (host/content-length/accept-encoding) and the
 * `anthropic-version` default, which differ per boundary.
 */
export function applyClaudeOauthGatewayHeaders(headers: Headers, accessToken: string): Headers {
  // Bearer-only: never let a caller-supplied api-key ride along upstream.
  headers.delete("x-api-key");
  // Force the real subscription bearer, overwriting the placeholder loopback
  // bearer the driver signed the request with. `set` replaces any existing
  // (case-insensitive) authorization entry.
  headers.set("authorization", `Bearer ${accessToken}`);
  // Add the OAuth beta, preserving the driver's own betas.
  headers.set("anthropic-beta", mergeAnthropicBeta(headers.get("anthropic-beta")));
  return headers;
}

/**
 * Anthropic-native `authentication_error` envelope (HTTP 401) the official
 * `claude` binary understands, so the surface can render an actionable
 * "reconnect your subscription" message instead of an opaque transport error or
 * a misleading "model not enabled". Used by the chat-side gateway's reconnect
 * paths; the message is user-facing (French).
 */
export function anthropicAuthErrorResponse(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Reconnectez votre abonnement Claude — la connexion a expiré ou été révoquée.",
      },
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}
