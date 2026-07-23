// SPDX-License-Identifier: Apache-2.0

/**
 * Loopback bearer for the chat module's own server-side platform calls.
 *
 * The platform's proxy surfaces are bearer-only (cookie sessions refused —
 * the drive-by CSRF threat model). The chat module's `/api/llm-proxy` call
 * is a server-side loopback, not a browser request, but the proxy cannot
 * tell from a cookie — so the module mints a bearer only IT can produce:
 *
 *   - the signing secret is generated in-memory at module init and never
 *     leaves the process (no persistence, no transmission);
 *   - tokens are short-lived and carry exactly the caller's identity
 *     (already authenticated by the platform pipeline on the /api/chat
 *     request) — no privilege amplification;
 *   - the token embeds its OWN least-privilege scope: the minter decides
 *     the exact permission set and whether the first-party-loopback
 *     capability is granted. Nothing else on the platform accepts this
 *     token shape, and the strategy no-matches instantly on any other header.
 *
 * Two minters share this machinery:
 *
 *   - `mintLoopbackToken` — the INFERENCE bearer (ai-sdk path). Scope
 *     `llm-proxy:call` + `models:read`, `firstPartyLoopback: true` (the
 *     llm-proxy accepts a loopback caller without an API key).
 *   - `mintMcpLoopbackToken` — the platform-MCP bearer handed to the
 *     in-process Pi subscription engine. Scope is the caller's own already-
 *     resolved permission set (RBAC fidelity, no amplification) and
 *     `firstPartyLoopback: false` — it authorizes the MCP meta-tools but
 *     can NEVER be replayed against the inference proxy.
 *
 * Contributed through the standard `authStrategies()` module extension
 * point. The strategy declares the `firstPartyLoopback` capability on its
 * `AuthResolution` only when the token itself grants it; the bearer-only
 * proxy gates accept on THAT declared capability (not on this module's
 * auth-method id) — see `bearer-only.ts`.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthStrategy, AuthResolution } from "@appstrate/core/module";

export const CHAT_LOOPBACK_AUTH_METHOD = "chat-loopback";
const PREFIX = "Bearer chatloop_";
const TOKEN_TTL_MS = 60_000;

/** Least-privilege scope for the inference (`/api/llm-proxy`) loopback path. */
const INFERENCE_PERMISSIONS = ["llm-proxy:call", "models:read"] as const;

// Process-local secret — regenerated at every boot, shared between the
// minting side (chat-stream) and the verifying side (auth strategy) only
// through this module's memory.
const secret = randomBytes(32);

/** Caller identity carried by every loopback bearer. */
interface LoopbackIdentity {
  userId: string;
  email: string;
  name: string;
  orgId: string;
  orgRole: string;
}

interface LoopbackClaims extends LoopbackIdentity {
  exp: number;
  /** Exact permission set this token resolves to (no role re-derivation). */
  permissions: string[];
  /** Whether the token grants the first-party-loopback capability. */
  firstPartyLoopback: boolean;
  /**
   * Chat session this token's usage should be attributed to. Signed INTO the
   * claims so the llm-proxy reads it from a validated token, never a spoofable
   * header. Absent on the MCP bearer and on ephemeral (unpersisted) turns.
   */
  chatSessionId?: string | null;
}

function sign(payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Serialize + sign a claims payload into a `chatloop_` bearer. */
function mint(
  identity: LoopbackIdentity,
  permissions: readonly string[],
  firstPartyLoopback: boolean,
  ttlMs: number,
  chatSessionId?: string | null,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      ...identity,
      exp: Date.now() + ttlMs,
      permissions: [...permissions],
      firstPartyLoopback,
      ...(chatSessionId ? { chatSessionId } : {}),
    } satisfies LoopbackClaims),
  ).toString("base64url");
  return `chatloop_${payload}.${sign(payload)}`;
}

/**
 * Mint the INFERENCE loopback bearer (`llm-proxy:call` + `models:read`,
 * first-party-loopback granted).
 *
 * The default 60 s TTL fits the `ai-sdk` path, which re-mints on every proxy
 * call. A caller whose token must live across a whole multi-step turn (minutes
 * — blocking run long-polls) passes a longer `ttlMs`. The token stays
 * least-privilege and process-local either way.
 */
export function mintLoopbackToken(
  identity: LoopbackIdentity,
  opts?: { ttlMs?: number; chatSessionId?: string | null },
): string {
  return mint(
    identity,
    INFERENCE_PERMISSIONS,
    true,
    opts?.ttlMs ?? TOKEN_TTL_MS,
    opts?.chatSessionId,
  );
}

/**
 * Mint the platform-MCP loopback bearer handed to the in-process Pi
 * subscription engine for its own `/api/mcp/o/:org` connection.
 *
 * `permissions` MUST be the caller's already-resolved permission set (from
 * `c.get("permissions")`): the MCP meta-tools re-enter the platform in-process
 * and re-authorize each underlying operation against exactly this set, so
 * carrying the caller's own permissions preserves full RBAC fidelity WITHOUT
 * amplifying beyond what the caller could already do over REST. The token does
 * NOT grant `firstPartyLoopback`, so — unlike the inference bearer — it can
 * never be replayed against the inference proxy.
 *
 * The engine bakes these headers once and may reconnect across the turn, so
 * callers pass a `ttlMs` that spans the whole turn.
 */
export function mintMcpLoopbackToken(
  identity: LoopbackIdentity & { permissions: readonly string[] },
  opts?: { ttlMs?: number },
): string {
  const { permissions, ...rest } = identity;
  return mint(rest, permissions, false, opts?.ttlMs ?? TOKEN_TTL_MS);
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

    // Scope + capability are carried IN the (HMAC-signed) claims — a token can
    // only ever resolve to the permissions its minter embedded. Both minters
    // live in this module and set them explicitly; a payload missing them is
    // malformed and refused like any other invalid token (fail closed).
    if (!Array.isArray(claims.permissions)) return null;
    const permissions = claims.permissions;

    return {
      user: { id: claims.userId, email: claims.email, name: claims.name },
      orgId: claims.orgId,
      orgRole: claims.orgRole as AuthResolution["orgRole"],
      authMethod: CHAT_LOOPBACK_AUTH_METHOD,
      // Only granted when the token itself carries the capability (the inference
      // bearer). The MCP bearer sets it false, so core never lets it reach the
      // subscription LLM gateway. Safe to set true for the inference bearer: it
      // is server-minted from a process-local secret (see top-of-file rationale).
      firstPartyLoopback: claims.firstPartyLoopback === true,
      permissions,
      // Surface the signed chat-session attribution as opaque strategy metadata
      // (→ `c.get("authExtra")`). The llm-proxy stamps it on the usage row; only
      // present on the inference bearer for a persisted turn.
      ...(typeof claims.chatSessionId === "string"
        ? { extra: { chatSessionId: claims.chatSessionId } }
        : {}),
    };
  },
};
