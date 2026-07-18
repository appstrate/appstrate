// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth transaction binding — server-side, browser-unforgeable resolution of
 * "which OAuth client is this Better Auth signup happening for?" (CRIT-15).
 *
 * The original design pinned the in-flight client in the signed
 * `oidc_pending_client` cookie. A signed cookie proves the SERVER minted the
 * value, but not that it belongs to THIS transaction: the caller fully
 * controls whether their browser presents it (strip it → the resolver sees
 * "no OIDC flow" and mints a full `platform`-realm user for an application
 * signup), and the single global cookie at `Path=/` is clobbered by a
 * concurrent flow in a second tab. The fix is to derive the client from a
 * binding keyed by the transaction identifier that Better Auth itself
 * carries through each round trip:
 *
 *   1. Social / OAuth callback (`/callback/:id`): BA stores the state data —
 *      including the `callbackURL` fixed at `POST /sign-in/social` time — in
 *      its `verification` table keyed by the single-use `state` parameter.
 *      At the callback, `parseState()` consumes that row (single-use,
 *      10-min TTL, cookie double-check) and publishes the parsed data in
 *      BA's request-scoped OAuth state (`getOAuthState()` from
 *      `better-auth/api`, verified in better-auth 1.7.0-beta.4:
 *      `dist/oauth2/state.mjs` line 49 `setOAuthState(parsedData)`;
 *      `dist/api/to-auth-endpoints.mjs` line 189 wraps every endpoint in
 *      `runWithRequestState`). When the transaction's `callbackURL` resumes
 *      our OAuth authorize endpoint, its `client_id` is the client this
 *      social sign-in was initiated for — the browser cannot rewrite it
 *      after initiation.
 *
 *   2. Magic-link verify (`/magic-link/verify`): the emailed link's
 *      single-use `token` is the transaction identifier. At issuance time
 *      (`POST /api/oauth/magic-link`, a server-driven route that knows the
 *      authorize-validated client), the OIDC module persists a
 *      `(sha256(token) → clientId)` record via `bindIssuedMagicLink` (wired
 *      through `setMagicLinkIssuedHook` in `@appstrate/db/auth`). The
 *      verify leg looks the binding up by the token in `query` — cookies
 *      play no part. The record lives in the Better Auth `verification`
 *      table (DB-backed: correct on Tier 0 PGlite, multi-instance
 *      deployments, and process restarts — an in-memory or Redis-optional
 *      store would not be). It is inert after use because the token itself
 *      is consumed atomically by BA on first verification; the row expires
 *      via `expiresAt` and is swept with the rest of the verification
 *      table.
 *
 *   3. Email/password register (`POST /api/oauth/register`): the route
 *      re-mints an authoritative `oidc_pending_client` cookie header from
 *      the validated authorize query (`headersWithAuthoritativePendingClient`)
 *      before calling BA in-process — the browser never gets a chance to
 *      strip it. The cookie read here is therefore server-authored on that
 *      path; for everything else it is a legacy/UX fallback only.
 *
 * Consumers (`oidcRealmResolver`, `oidcBeforeSignupGuard`,
 * `oidcAfterSignupHandler`) treat the result as:
 *   - `bound`   → apply the bound client's policy.
 *   - `invalid` → an OIDC transaction was positively detected but its
 *                 binding is incoherent — FAIL CLOSED (never downgrade to
 *                 `platform`).
 *   - `none`    → positively not an OIDC-initiated creation (dashboard
 *                 signup, invitation, direct BA API call) → platform rules.
 */

import { eq } from "drizzle-orm";
import { getOAuthState } from "better-auth/api";
import { db } from "@appstrate/db/client";
import { verification } from "@appstrate/db/schema";
import type { MagicLinkIssuedInfo } from "@appstrate/db/auth";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../../../lib/logger.ts";
import { readPendingClientCookieFromHeaders } from "./pending-client-cookie.ts";

/**
 * Path of the Better Auth OAuth authorize endpoint (oauth-provider plugin
 * under `basePath: "/api/auth"`). A social transaction whose stored
 * `callbackURL` resumes this endpoint IS an OIDC flow for the `client_id`
 * in its query.
 */
export const OAUTH_AUTHORIZE_PATHNAME = "/api/auth/oauth2/authorize";

/** BA endpoint route pattern for the magic-link verify leg. */
export const MAGIC_LINK_VERIFY_PATH = "/magic-link/verify";

const MAGIC_LINK_BINDING_PREFIX = "oidc-pending-client:";

/**
 * Magic-link tokens live 15 minutes (`expiresIn` in `packages/db/src/auth.ts`).
 * The binding must strictly outlive the token so a still-valid link can never
 * dangle without its binding (which would downgrade an application signup to
 * the cookie fallback).
 */
const MAGIC_LINK_BINDING_TTL_MS = 16 * 60 * 1000;

export interface TransactionContext {
  headers: Headers | null;
  path?: string | null;
  query?: Record<string, unknown> | null;
}

export type PendingClientBinding =
  | { kind: "bound"; clientId: string; source: "oauth-state" | "magic-link" | "cookie" }
  | { kind: "invalid" }
  | { kind: "none" };

/**
 * Resolve the OAuth client bound to the in-flight Better Auth user
 * creation. Precedence: OAuth callback state → magic-link token binding →
 * pending-client cookie. See the file header for why each source is
 * ordered this way and what `invalid` vs `none` mean.
 */
export async function resolvePendingClientBinding(
  ctx: TransactionContext,
): Promise<PendingClientBinding> {
  // ── 1. Social / OAuth callback leg ────────────────────────────────────────
  const state = await readOAuthCallbackState();
  if (state) {
    const analyzed = analyzeOAuthCallbackURL(state.callbackURL);
    if (analyzed.kind === "oidc") {
      return { kind: "bound", clientId: analyzed.clientId, source: "oauth-state" };
    }
    if (analyzed.kind === "invalid") return { kind: "invalid" };
    // The transaction's server-stored destination is NOT our authorize
    // endpoint → positively a non-OIDC social sign-in (e.g. dashboard).
    // Do NOT fall back to the ambient cookie: a concurrent OIDC tab must
    // not leak its client into this unrelated transaction (the two-tab
    // clobbering the cookie design suffered from).
    return { kind: "none" };
  }

  // ── 2. Magic-link verify leg ──────────────────────────────────────────────
  const token = magicLinkTokenFrom(ctx);
  if (token) {
    const boundClientId = await findMagicLinkClientBinding(token);
    if (boundClientId) return { kind: "bound", clientId: boundClientId, source: "magic-link" };
    // No server-side binding: either a direct (non-OIDC) call against BA's
    // public `/sign-in/magic-link` endpoint, or a link issued before this
    // mechanism deployed (links live ≤15 min). Fall through to the cookie
    // so in-flight links keep working across a deploy; a stripped cookie
    // then resolves to `none` — the same posture a direct BA magic-link
    // signup legitimately gets (platform rules + platform signup gates).
  }

  // ── 3. Cookie: authoritative on the server-driven register path (re-minted
  //      from the validated authorize query), legacy/UX fallback elsewhere. ──
  const cookieClientId = readPendingClientCookieFromHeaders(ctx.headers);
  if (cookieClientId) return { kind: "bound", clientId: cookieClientId, source: "cookie" };
  return { kind: "none" };
}

// ─── Social / OAuth callback transaction ──────────────────────────────────────

/**
 * Read the parsed OAuth state of the current Better Auth request, when the
 * request is an OAuth callback whose single-use `state` was successfully
 * consumed. Returns `null` on every other endpoint and outside BA request
 * scope (seeds, out-of-band hook invocations in tests).
 */
async function readOAuthCallbackState(): Promise<{ callbackURL: string } | null> {
  try {
    return await getOAuthState();
  } catch {
    // `getOAuthState()` throws outside `runWithRequestState` — i.e. the
    // user creation is not flowing through a Better Auth endpoint at all.
    return null;
  }
}

export type CallbackURLAnalysis =
  | { kind: "oidc"; clientId: string }
  | { kind: "invalid" }
  | { kind: "not-oidc" };

/**
 * Classify a social transaction's server-stored `callbackURL`.
 *
 * Matching is on the pathname suffix only (never the origin): the
 * callbackURL was already origin-validated by BA's trustedOrigins check at
 * sign-in initiation, and pinning to `APP_URL`'s origin here would turn an
 * operator origin mismatch (reverse proxy, custom domain) into a silent
 * fail-open (`not-oidc` → platform). Over-matching errs in the fail-closed
 * direction instead — an authorize-shaped URL without a resolvable client
 * aborts the creation.
 */
export function analyzeOAuthCallbackURL(callbackURL: string): CallbackURLAnalysis {
  let url: URL;
  try {
    // Base handles relative callbackURLs ("/", "/dashboard", …); only the
    // pathname + query are inspected.
    url = new URL(callbackURL, "http://relative.invalid");
  } catch {
    // An unparseable destination on a real OAuth transaction cannot be
    // classified — refuse rather than default to platform.
    return { kind: "invalid" };
  }
  if (!url.pathname.endsWith(OAUTH_AUTHORIZE_PATHNAME)) return { kind: "not-oidc" };
  const clientId = url.searchParams.get("client_id");
  if (!clientId) return { kind: "invalid" };
  return { kind: "oidc", clientId };
}

// ─── Magic-link token binding ────────────────────────────────────────────────

function magicLinkTokenFrom(ctx: TransactionContext): string | null {
  if (ctx.path !== MAGIC_LINK_VERIFY_PATH) return null;
  const token = ctx.query?.token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * Storage key for a magic-link binding. The token is a bearer credential —
 * store a digest, never the token itself (BA's own copy is its problem;
 * ours should not widen the exposure).
 */
function magicLinkBindingKey(token: string): string {
  const digest = new Bun.CryptoHasher("sha256").update(token).digest("hex");
  return `${MAGIC_LINK_BINDING_PREFIX}${digest}`;
}

/**
 * Persist the `(token → clientId)` binding for a magic link issued inside an
 * OIDC flow. Stored in the Better Auth `verification` table — additive, no
 * migration, DB-backed on every tier. Single-use by construction: the token
 * that keys it is consumed atomically by BA on first verification, so a
 * leftover row is inert and lapses via `expiresAt`.
 */
export async function persistMagicLinkClientBinding(
  token: string,
  clientId: string,
): Promise<void> {
  await db.insert(verification).values({
    id: crypto.randomUUID(),
    identifier: magicLinkBindingKey(token),
    value: clientId,
    expiresAt: new Date(Date.now() + MAGIC_LINK_BINDING_TTL_MS),
  });
}

async function findMagicLinkClientBinding(token: string): Promise<string | null> {
  const [row] = await db
    .select({ value: verification.value, expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.identifier, magicLinkBindingKey(token)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row.value;
}

/**
 * `setMagicLinkIssuedHook` implementation, wired in the module's `init()`.
 * Runs inside `sendMagicLink` BEFORE the email is sent. The headers here are
 * the ones `POST /api/oauth/magic-link` passed to `signInMagicLink` — that
 * route re-mints an AUTHORITATIVE pending-client cookie header from the
 * validated authorize query (`headersWithAuthoritativePendingClient`), so
 * the binding is pinned to the client the server authorized, not to
 * browser-supplied state. A direct (non-OIDC) call to BA's public
 * magic-link endpoint carries no such marker and writes no binding —
 * its eventual signup is a plain platform signup under platform gates.
 *
 * FAIL CLOSED: a persistence failure rethrows, which aborts the email send
 * in `sendMagicLink`'s surrounding try/catch — better no email than an
 * OIDC link whose verify leg would fall back to forgeable browser state.
 */
export async function bindIssuedMagicLink(info: MagicLinkIssuedInfo): Promise<void> {
  const clientId = readPendingClientCookieFromHeaders(info.headers);
  if (!clientId) return;
  try {
    await persistMagicLinkClientBinding(info.token, clientId);
  } catch (err) {
    logger.error("oidc: failed to persist magic-link client binding — aborting send", {
      module: "oidc",
      clientId,
      error: getErrorMessage(err),
    });
    throw err;
  }
}
