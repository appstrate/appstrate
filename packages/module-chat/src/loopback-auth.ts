// SPDX-License-Identifier: Apache-2.0

/**
 * Loopback bearer for the chat module's own inference calls.
 *
 * The platform's proxy surfaces are bearer-only (cookie sessions refused —
 * the drive-by CSRF threat model). The chat module's `/api/llm-proxy` call
 * is a server-side loopback, not a browser request, but the proxy cannot
 * tell from a cookie — so the module mints a bearer only IT can produce:
 *
 *   - the signing secret is generated in-memory at module init and never
 *     leaves the process (no persistence, no transmission);
 *   - tokens expire after 60 seconds and carry exactly the caller's
 *     identity (already authenticated by the platform pipeline on the
 *     /api/chat request) — no privilege amplification;
 *   - the resolved permissions are the least required: `llm-proxy:call`
 *     + `models:read`. Nothing else on the platform accepts this token
 *     shape, and the strategy no-matches instantly on any other header.
 *
 * Contributed through the standard `authStrategies()` module extension
 * point; `assertBearerOnly` accepts the strategy id alongside the OIDC
 * JWT methods.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthStrategy, AuthResolution } from "@appstrate/core/module";

export const CHAT_LOOPBACK_AUTH_METHOD = "chat-loopback";
const PREFIX = "Bearer chatloop_";
const TOKEN_TTL_MS = 60_000;

// Process-local secret — regenerated at every boot, shared between the
// minting side (chat-stream) and the verifying side (auth strategy) only
// through this module's memory.
const secret = randomBytes(32);

interface LoopbackClaims {
  userId: string;
  email: string;
  name: string;
  orgId: string;
  orgRole: string;
  exp: number;
}

function sign(payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Mint a loopback bearer.
 *
 * The default 60 s TTL fits the `ai-sdk` path, which re-mints on every proxy
 * call. The Claude Agent SDK path can't — it bakes the bearer into the spawned
 * binary's env once at turn start (`ANTHROPIC_AUTH_TOKEN`), and the turn can
 * run for minutes (multi-step + blocking run long-polls). It passes a longer
 * `ttlMs` so the token outlives the whole turn. The token stays least-privilege
 * (`llm-proxy:call` + `models:read`), process-local, and only usable on the
 * 127.0.0.1 first-party gateway.
 */
export function mintLoopbackToken(
  claims: Omit<LoopbackClaims, "exp">,
  opts?: { ttlMs?: number },
): string {
  const payload = Buffer.from(
    JSON.stringify({
      ...claims,
      exp: Date.now() + (opts?.ttlMs ?? TOKEN_TTL_MS),
    } satisfies LoopbackClaims),
  ).toString("base64url");
  return `chatloop_${payload}.${sign(payload)}`;
}

export const chatLoopbackStrategy: AuthStrategy = {
  id: CHAT_LOOPBACK_AUTH_METHOD,

  async authenticate({ headers }): Promise<AuthResolution | null> {
    const auth = headers.get("authorization") ?? "";
    // Fast no-match: anything that isn't ours passes straight through.
    if (!auth.startsWith(PREFIX)) return null;

    const [payload, signature] = auth.slice(PREFIX.length).split(".");
    if (!payload || !signature) return null;
    const expected = sign(payload);
    const given = Buffer.from(signature);
    const wanted = Buffer.from(expected);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;

    let claims: LoopbackClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as LoopbackClaims;
    } catch {
      return null;
    }
    if (claims.exp < Date.now()) return null;

    return {
      user: { id: claims.userId, email: claims.email, name: claims.name },
      orgId: claims.orgId,
      orgRole: claims.orgRole as AuthResolution["orgRole"],
      authMethod: CHAT_LOOPBACK_AUTH_METHOD,
      // Declare the first-party-loopback capability the bearer-only proxy gates
      // read — so core gates on a property, not on this module's auth-method id.
      // Safe to set: this bearer is server-minted from a process-local secret
      // that never leaves the process (see top-of-file rationale).
      firstPartyLoopback: true,
      // Least privilege: exactly what the inference loopback needs.
      permissions: ["llm-proxy:call", "models:read"],
    };
  },
};
