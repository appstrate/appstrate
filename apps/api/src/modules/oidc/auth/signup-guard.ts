// SPDX-License-Identifier: Apache-2.0

/**
 * `databaseHooks.user.create.before` handler for the OIDC module.
 *
 * Runs during Better Auth's user creation for every signup path — email +
 * password (our own `POST /api/oauth/register`), social (`POST
 * /api/auth/sign-in/social` + provider callback), and magic-link verify.
 * Blocks the creation of a brand-new Better Auth user whenever the pending
 * OAuth client has `allowSignup === false`, regardless of level. Preventing
 * the orphan user at BA-level is strictly stronger than relying on the
 * GET-time guards (which only hide the UI surfaces) or the late reject in
 * `buildOrgLevelClaims` (which leaves a dangling BA user row with no org
 * membership).
 *
 * Mechanism: the OIDC entry pages (`/api/oauth/login`, `/api/oauth/register`,
 * `/api/oauth/magic-link`) issue a signed `oidc_pending_client` cookie that
 * pins the client_id context. This guard reads the cookie on the BA hook
 * path (the only state that survives the cross-site social redirect chain)
 * and applies a single, level-agnostic policy check via
 * `loadClientSignupPolicy`.
 *
 * Level semantics:
 *   - `org`      → `allowSignup` gates the guard; on pass, `oidcAfterSignupHandler`
 *                  auto-joins the new BA user to `referencedOrgId`.
 *   - `instance` → `allowSignup` gates the guard; auto-provisioned platform
 *                  client is `true`, env-declared satellites are `false`.
 *                  No post-signup action.
 *   - `application` → pass-through. End-users are created via the headless
 *                     API, not through Better Auth; the pending-client
 *                     cookie should never block a legitimate flow.
 *
 * Safe fallthrough: the guard is a no-op when no cookie is present, its
 * signature is invalid/expired, or the client is unknown / disabled.
 */

import { APIError } from "better-auth/api";
import { logger } from "../../../lib/logger.ts";
import {
  loadClientSignupPolicy,
  resolveOrCreateOrgMembership,
  OrgSignupClosedError,
} from "../services/orgmember-mapping.ts";
import { readPendingClientCookieFromHeaders } from "../services/pending-client-cookie.ts";

/**
 * Input shape accepted by the guard. We intentionally keep it minimal (the
 * about-to-be-created Better Auth user + the request headers) so the function
 * has no coupling to BA's internal `GenericEndpointContext` type — the core
 * wiring in `packages/db/src/auth.ts` extracts and forwards the two pieces.
 */
export interface BeforeSignupGuardInput {
  /** The user BA is about to create. Only `email` is required. */
  user: { email: string };
  /** Request headers — `null` if the signup is happening outside an HTTP context. */
  headers: Headers | null;
}

/**
 * BA hook handler. Throws `APIError(FORBIDDEN, signup_disabled)` to abort
 * the user creation; BA surfaces this as a JSON error on `/api/auth/*`
 * endpoints, and the `errorCallbackURL` (set by the social sign-in script
 * to `/api/oauth/login?...`) catches the redirect.
 */
export async function oidcBeforeSignupGuard(input: BeforeSignupGuardInput): Promise<void> {
  const pendingClientId = readPendingClientCookieFromHeaders(input.headers);
  if (!pendingClientId) {
    // Signup outside an OIDC flow — defer to other modules (e.g. cloud
    // free-tier hook) and the core signup path.
    return;
  }

  const policy = await loadClientSignupPolicy(pendingClientId);
  if (!policy) {
    // Unknown or disabled client → no policy to enforce. Let core handle
    // the signup through its default path.
    logger.debug("oidc: beforeSignup guard pass-through", {
      module: "oidc",
      pendingClientId,
      email: input.user.email,
      reason: "no-policy",
    });
    return;
  }

  if (policy.level === "application") {
    // Application-level clients mint end-user tokens, not Better Auth
    // users. The pending-client cookie is still set for symmetry, but the
    // signup going through BA here is unrelated (e.g. a staff login on the
    // same origin) and must not be blocked.
    logger.debug("oidc: beforeSignup guard pass-through", {
      module: "oidc",
      pendingClientId,
      email: input.user.email,
      reason: "application-level",
    });
    return;
  }

  if (policy.allowSignup) {
    // Open policy (org with opt-in signup or platform instance client) —
    // let the signup through; `afterSignup` may auto-join for org-level.
    logger.debug("oidc: beforeSignup guard pass-through", {
      module: "oidc",
      pendingClientId,
      level: policy.level,
      orgId: policy.orgId,
      email: input.user.email,
      reason: "signup-open",
    });
    return;
  }

  // Closed policy: block the BA user creation outright. The browser ends
  // up on `errorCallbackURL` (/api/oauth/login?...) for social flows, or
  // sees a JSON error for direct API calls.
  //
  // NOTE on the body shape: Better Auth's `APIError` extends better-call's
  // `InternalAPIError`, whose constructor does `super(body?.message)` — so
  // the `.message` field is what flows through `handleOAuthUserInfo`'s
  // catch block as `result.error`. Using an OAuth2-flavored
  // `{ error, error_description }` body leaves `.message` empty, which BA
  // then reads as a falsy `result.error`, skips the error branch in
  // `callback.mjs`, and crashes on `const { session } = result.data`.
  // Always put the primary string in `message`; keep the machine-readable
  // code under `code` so frontends can still switch on it.
  logger.info("oidc: beforeSignup guard blocked orphan signup", {
    module: "oidc",
    pendingClientId,
    level: policy.level,
    orgId: policy.orgId,
    email: input.user.email,
  });
  throw new APIError("FORBIDDEN", {
    message: "signup_disabled",
    code: "signup_disabled",
  });
}

/**
 * `databaseHooks.user.create.after` handler for the OIDC module.
 *
 * Symmetric to `oidcBeforeSignupGuard`: reads the same signed
 * `oidc_pending_client` cookie, and — if the request is a brand-new BA user
 * being provisioned through an org-level client with `allowSignup === true`
 * — inserts the `organization_members` row BEFORE the onward redirect back
 * through `/api/auth/oauth2/authorize`.
 *
 * Why it matters: the social sign-in flow bounces
 *   `/api/oauth/login` → BA sign-in/social → Google → BA callback → callbackURL
 * where `callbackURL` is `/api/auth/oauth2/authorize?...`. Without this
 * post-signup join, the user arriving at authorize has a fresh BA session
 * but zero org memberships. On the dashboard client, the SPA would then
 * deep-link to the onboarding flow; on a third-party client, the membership
 * would be created later by `buildOrgLevelClaims` at `/token` mint time —
 * but only if authorize actually issued a code, which itself depends on
 * session state and consent. Auto-joining here keeps the session coherent
 * end-to-end and removes the race.
 *
 * Pass-through on every signup that is not gated by an org-level client —
 * same rules as the `before` guard. The `allowSignup === false` case never
 * reaches this hook (the `before` guard already threw).
 *
 * Safe to run after `buildOrgLevelClaims` also calls
 * `resolveOrCreateOrgMembership`: step 1 of that service is a SELECT-only
 * lookup that short-circuits when a row already exists.
 */
export async function oidcAfterSignupHandler(input: {
  user: { id: string; email: string };
  headers: Headers | null;
}): Promise<void> {
  const pendingClientId = readPendingClientCookieFromHeaders(input.headers);
  if (!pendingClientId) return;

  const policy = await loadClientSignupPolicy(pendingClientId);
  if (!policy) return;

  // Only org-level clients need a post-signup auto-join. Instance and
  // application clients have no org context to map into — the before
  // guard already let them through (or blocked them).
  if (policy.level !== "org") return;
  if (!policy.orgId) return;
  if (!policy.allowSignup) {
    // Defensive: `before` guard should have thrown already.
    return;
  }

  try {
    await resolveOrCreateOrgMembership(
      { id: input.user.id, email: input.user.email },
      policy.orgId,
      { allowSignup: policy.allowSignup, signupRole: policy.signupRole },
    );
    logger.info("oidc: auto-joined new signup to organization", {
      module: "oidc",
      pendingClientId,
      orgId: policy.orgId,
      userId: input.user.id,
      email: input.user.email,
      role: policy.signupRole,
    });
  } catch (err) {
    if (err instanceof OrgSignupClosedError) {
      // Cannot happen after the `before` guard, but log for visibility.
      logger.warn("oidc: afterSignup reached closed-policy branch", {
        module: "oidc",
        pendingClientId,
        orgId: policy.orgId,
        userId: input.user.id,
      });
      return;
    }
    throw err;
  }
}
