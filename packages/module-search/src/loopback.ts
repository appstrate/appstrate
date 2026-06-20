// SPDX-License-Identifier: Apache-2.0

/**
 * Loopback identity for the search module's INGESTION reads.
 *
 * search indexes storage objects, so it must read their bytes — by the opaque
 * object id, through storage's public read seam (`GET /api/storage/objects/:id
 * /content`), NEVER by joining storage's tables (strategy §5). That endpoint is
 * `requireModulePermission("storage", "read")` + applies the object ACL.
 *
 * Ingestion is triggered by an EVENT, not an HTTP request — there is no caller
 * session to forward (the chat module forwards the caller's own credentials;
 * search has none). So search mints a bearer only THIS process can produce and
 * presents it on the loopback call:
 *
 *   - the signing secret is generated in-memory at module init and never leaves
 *     the process (no persistence, no transmission) — unforgeable from outside;
 *   - tokens expire after 60 s and carry the object owner's identity so the
 *     storage ACL resolves exactly as it would for that owner (org-visible
 *     objects pass for any id; a private object passes only for its owner);
 *   - the resolved permission is the least required: `storage:read` and nothing
 *     else. The token grants no write, no other resource — its only power is the
 *     ingestion read search legitimately needs.
 *
 * Contributed through the standard `authStrategies()` module extension point.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthStrategy, AuthResolution } from "@appstrate/core/module";

export const SEARCH_LOOPBACK_AUTH_METHOD = "search-loopback";
const PREFIX = "Bearer searchloop_";
const TOKEN_TTL_MS = 60_000;

// Process-local secret — regenerated at every boot, shared between the minting
// side (service.ts ingestion) and the verifying side (this strategy) only
// through this module's memory.
const secret = randomBytes(32);

interface LoopbackClaims {
  userId: string;
  orgId: string;
  exp: number;
}

function sign(payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function mintLoopbackToken(claims: { userId: string; orgId: string }): string {
  const payload = Buffer.from(
    JSON.stringify({ ...claims, exp: Date.now() + TOKEN_TTL_MS } satisfies LoopbackClaims),
  ).toString("base64url");
  return `searchloop_${payload}.${sign(payload)}`;
}

/** Loopback origin of the running platform (same process, no proxy hop). */
export function selfOrigin(): string {
  return process.env.SEARCH_SELF_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
}

export const searchLoopbackStrategy: AuthStrategy = {
  id: SEARCH_LOOPBACK_AUTH_METHOD,

  async authenticate({ headers }): Promise<AuthResolution | null> {
    const auth = headers.get("authorization") ?? "";
    // Fast no-match: anything that isn't ours passes straight through.
    if (!auth.startsWith(PREFIX)) return null;

    const [payload, signature] = auth.slice(PREFIX.length).split(".");
    if (!payload || !signature) return null;
    const given = Buffer.from(signature);
    const wanted = Buffer.from(sign(payload));
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;

    let claims: LoopbackClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as LoopbackClaims;
    } catch {
      return null;
    }
    if (claims.exp < Date.now()) return null;

    return {
      user: { id: claims.userId, email: "", name: "search-indexer" },
      orgId: claims.orgId,
      authMethod: SEARCH_LOOPBACK_AUTH_METHOD,
      // Least privilege: exactly what the ingestion read needs.
      permissions: ["storage:read"],
    };
  },
};
