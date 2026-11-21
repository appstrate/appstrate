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
 *     (already authenticated by the platform pipeline on the chat turn
 *     request) — no privilege amplification; the strategy therefore declares
 *     `principalKind: "user"`, so personal spaces and per-principal grants reach
 *     the engine's turn exactly as they reach the caller's own request;
 *   - the token embeds its OWN least-privilege scope: the minter decides
 *     the exact permission set and whether the first-party-loopback
 *     capability is granted. Nothing else on the platform accepts this
 *     token shape, and the strategy no-matches instantly on any other header.
 *
 * Two minters share this machinery:
 *
 *   - `mintLoopbackToken` — the INFERENCE bearer (llm-proxy calls). Scope
 *     `llm-proxy:call` + `models:read`, `firstPartyLoopback: true` (the
 *     llm-proxy accepts a loopback caller without an API key).
 *   - `mintMcpLoopbackToken` — the platform-MCP bearer handed to the
 *     in-process Pi engine. Scope is the caller's own already-
 *     resolved permission set (RBAC fidelity, no amplification) and
 *     `firstPartyLoopback: false` — it authorizes the MCP tools, the
 *     integration tools among them, but can NEVER be replayed against the
 *     inference proxy.
 *
 * Contributed through the standard `authStrategies()` module extension
 * point. The strategy declares `serverMinted` on every token it verifies (each
 * is built from the process-local secret, so none carries CSRF risk — the
 * credential proxy accepts it), and `firstPartyLoopback` only when the token
 * itself grants it. The bearer-only proxy gates accept on THOSE declared
 * capabilities (not on this module's auth-method id) — see `bearer-only.ts`.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthStrategy, AuthResolution } from "@appstrate/core/module";
import {
  CHAT_LOOPBACK_AUTH_METHOD,
  INJECTED_SKILLS_AUTH_EXTRA,
  injectedSkillsSchema,
  type InjectedSkills,
} from "@appstrate/core/chat-contract";

/**
 * Deliberately NOT parsed with `parseBearer` (@appstrate/core/bearer), unlike
 * every externally-reachable bearer surface on the platform. RFC 6750 scheme
 * tolerance exists for third-party clients; this header is minted and verified
 * in this one file against a boot-local secret, so no external client ever
 * constructs it. Accepting a lowercase scheme here would widen an internal
 * auth surface for zero conformance benefit — leave the byte-exact match.
 */
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
  /**
   * Role preview in force on the minting request, verbatim; opaque here, the
   * platform owns its shape. In the SIGNED claims rather than a header because
   * the in-process MCP re-entry builds its own request — without it the hop
   * would run with the caller's REAL authority while a preview is on screen.
   */
  viewAs?: unknown;
  /** Exact permission set this token resolves to (no role re-derivation). */
  permissions: string[];
  /** Whether the token grants the first-party-loopback capability. */
  firstPartyLoopback: boolean;
  /**
   * Chat session that issued this token. Signed INTO the claims so the platform reads it
   * from a validated token, never a spoofable header: the llm-proxy attributes usage to it,
   * and a run launched with the MCP bearer may take the conversation's own files as inputs.
   * Absent on ephemeral (unpersisted) turns.
   */
  chatSessionId?: string | null;
  /** The skills the turn's prompt injected, as served; MCP bearer only (→ `skill://` reads). */
  injectedSkills?: InjectedSkills;
  /**
   * The turn's spaces, as a credential allowlist (`AuthResolution.spaceIds`): the only spaces
   * the bearer reaches; MCP bearer only. Absent means unbound — the inference bearer.
   */
  spaceIds?: string[];
  /** Whether `spaceIds` is a limit the person chose (a limited conversation); read only beside `spaceIds`. */
  restricted?: boolean;
}

function sign(payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Serialize + sign a claims payload into a `chatloop_` bearer; `ttlMs` sets its `exp`. */
function mint({ ttlMs, ...claims }: Omit<LoopbackClaims, "exp"> & { ttlMs: number }): string {
  const { chatSessionId, injectedSkills } = claims;
  const payload = Buffer.from(
    JSON.stringify({
      ...claims,
      exp: Date.now() + ttlMs,
      // Absent rather than empty: a claim the verifier reads only when present.
      chatSessionId: chatSessionId || undefined,
      injectedSkills:
        injectedSkills && Object.keys(injectedSkills.skills).length > 0
          ? injectedSkills
          : undefined,
    } satisfies LoopbackClaims),
  ).toString("base64url");
  return `chatloop_${payload}.${sign(payload)}`;
}

/**
 * Mint the INFERENCE loopback bearer (`llm-proxy:call` + `models:read`,
 * first-party-loopback granted).
 *
 * Every production caller takes the default 60 s TTL: the proxy binding re-mints
 * on every provider call (`chat-stream.ts` + `pi-chat/model-binding.ts`), so no
 * inference token ever has to outlive one request. The platform-MCP
 * bearer has its own minter and its own `ENGINE_LOOPBACK_TTL_MS`.
 *
 * `ttlMs` therefore survives as a test seam, not a production knob: it is how a
 * caller mints an ALREADY-expired token to exercise the verifier's expiry branch
 * (`test/loopback-auth.test.ts`). The token stays least-privilege and
 * process-local at any TTL.
 */
export function mintLoopbackToken(
  identity: LoopbackIdentity,
  opts?: { ttlMs?: number; chatSessionId?: string | null },
): string {
  return mint({
    ...identity,
    permissions: [...INFERENCE_PERMISSIONS],
    firstPartyLoopback: true,
    ttlMs: opts?.ttlMs ?? TOKEN_TTL_MS,
    chatSessionId: opts?.chatSessionId,
  });
}

/**
 * Mint the platform-MCP loopback bearer handed to the in-process Pi engine for
 * its own connection: the organization endpoint (`/api/mcp/o/:org`).
 *
 * `spaceIds` are the turn's spaces (a limited conversation's origin alone) and the ONLY ones
 * the bearer reaches (the generic credential allowlist, `AuthResolution.spaceIds`); each
 * request it makes acts in one of them.
 *
 * `permissions` MUST be the caller's already-resolved permission set (the union over
 * the turn's spaces): the MCP meta-tools re-enter the platform in-process
 * and re-authorize each underlying operation against exactly this set, so
 * carrying the caller's own permissions (narrowed by `turnPermissions` when the
 * turn may not author agents) never amplifies beyond what the caller could
 * already do over REST. The token does
 * NOT grant `firstPartyLoopback`, so — unlike the inference bearer — it can
 * never be replayed against the inference proxy. Like every token of this
 * strategy it is `serverMinted`, which is what lets the integration tools re-enter
 * the credential proxy with it.
 *
 * The engine bakes these headers once and may reconnect across the turn, so
 * callers pass a `ttlMs` that spans the whole turn.
 */
export function mintMcpLoopbackToken(
  identity: LoopbackIdentity & {
    permissions: readonly string[];
    viewAs?: unknown;
    injectedSkills?: InjectedSkills;
    /** The turn's spaces: the only ones the bearer reaches, each request acting in one. Absent: unbound. */
    spaceIds?: readonly string[];
    /** Whether the conversation is limited to a space (its connections then stay in it). Absent: limited. */
    restricted?: boolean;
    /** The persisted conversation of the turn, whose own files a run it launches may consume. */
    chatSessionId?: string | null;
  },
  opts?: { ttlMs?: number },
): string {
  const { permissions, spaceIds, restricted, ...rest } = identity;
  return mint({
    ...rest,
    permissions: [...permissions],
    firstPartyLoopback: false,
    ttlMs: opts?.ttlMs ?? TOKEN_TTL_MS,
    spaceIds: spaceIds && [...spaceIds],
    restricted: spaceIds ? restricted : undefined,
  });
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
    // A malformed map widens nothing: dropped, `skill://` reads fall back to `skills:read`.
    const injected = injectedSkillsSchema.safeParse(claims.injectedSkills);
    const injectedSkills = injected.success ? injected.data : undefined;
    // An allowlist narrows, so a malformed one is refused (fail closed) rather than dropped.
    if (
      claims.spaceIds !== undefined &&
      (!Array.isArray(claims.spaceIds) || !claims.spaceIds.every((id) => typeof id === "string"))
    ) {
      return null;
    }

    return {
      user: { id: claims.userId, email: claims.email, name: claims.name },
      orgId: claims.orgId,
      orgRole: claims.orgRole as AuthResolution["orgRole"],
      authMethod: CHAT_LOOPBACK_AUTH_METHOD,
      principalKind: "user",
      // Every token here is signed with the process-local secret: none ever reached
      // a browser, so the credential proxy may accept it (no CSRF risk).
      serverMinted: true,
      // Only granted when the token itself carries the capability (the inference
      // bearer). The MCP bearer sets it false, so core never lets it reach the
      // subscription LLM gateway. Safe to set true for the inference bearer: it
      // is server-minted from a process-local secret (see top-of-file rationale).
      firstPartyLoopback: claims.firstPartyLoopback === true,
      permissions,
      ...(claims.spaceIds !== undefined
        ? {
            spaceIds: claims.spaceIds,
            // Only an explicit `false` lifts the restriction; absent or malformed stays restricted.
            ...(claims.restricted === false ? { spaceIdsRestricted: false } : {}),
          }
        : {}),
      // Opaque strategy metadata (→ `c.get("authExtra")`, and `adoptViewAs` for
      // the preview). `chatSessionId` names the issuing conversation (usage
      // attribution, a run's inputs); `viewAs` is re-published before any permission is resolved.
      ...(claims.chatSessionId !== undefined ||
      claims.viewAs !== undefined ||
      injectedSkills !== undefined
        ? {
            extra: {
              ...(typeof claims.chatSessionId === "string"
                ? { chatSessionId: claims.chatSessionId }
                : {}),
              ...(claims.viewAs !== undefined ? { viewAs: claims.viewAs } : {}),
              ...(injectedSkills !== undefined
                ? { [INJECTED_SKILLS_AUTH_EXTRA]: injectedSkills }
                : {}),
            },
          }
        : {}),
    };
  },
};
