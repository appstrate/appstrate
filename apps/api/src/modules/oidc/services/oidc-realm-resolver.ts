// SPDX-License-Identifier: Apache-2.0

/**
 * Realm resolver — decides the `user.realm` value assigned to a brand-new
 * Better Auth user at creation time.
 *
 * Installed via `setRealmResolver()` during the OIDC module's `init()`.
 * Reads the signed `oidc_pending_client` cookie already plumbed through
 * every OIDC entry path (login, register, magic-link, social callback) by
 * the pages in `routes.ts`, looks up the client's signup policy (which
 * already resolves `applicationId` from the `level=application` branch),
 * and returns:
 *
 *   - `"end_user:<applicationId>"` when the cookie pins an application-level
 *     client. This is the single-user-pool isolation fix that prevents the
 *     newly minted BA user from being replayable against platform routes.
 *   - `"platform"` for org-level clients (whose users are real platform
 *     members auto-joined to the org), instance-level clients (satellite
 *     dashboards, themselves platform audiences), and the no-cookie case
 *     (direct dashboard signup, invitation flow, any non-OIDC BA sign-up).
 *
 * FAIL-CLOSED (CRIT-15). The presence of a valid, signed pending-client
 * cookie is a POSITIVE marker that this signup is happening inside an OIDC
 * transaction. Within such a transaction the realm MUST resolve to a coherent
 * audience — we never silently downgrade an un-resolvable OIDC flow to a full
 * `platform` user (that user would pass `requirePlatformRealm` on every
 * platform route). So a cookie that names an unknown/disabled client, or an
 * application-level client with no `applicationId`, ABORTS user creation
 * instead of defaulting to `platform`. The ONLY path that resolves to
 * `platform` from a missing cookie is a flow that was never an OIDC/application
 * flow to begin with (core dashboard signup) — established positively by the
 * absence of any OIDC marker, not inferred as a fallback for a broken one.
 *
 * Transaction binding: the server-driven create paths (`POST
 * /api/oauth/register`, magic-link request) feed this resolver an AUTHORITATIVE
 * pending-client cookie re-derived from the validated `authorize` query
 * (`headersWithAuthoritativePendingClient`), so a caller cannot strip/overwrite
 * their browser cookie to force the `platform` branch for an application flow.
 * The social callback + magic-link *verify* legs are driven by Better Auth
 * itself (no in-process header we can pin) and still read the browser cookie;
 * closing that residual fully requires the resolver to receive the request's
 * OAuth `state`, which the `RealmResolver(headers)` signature in
 * `packages/db/src/auth.ts` does not currently expose.
 *
 * See `packages/db/src/auth.ts::setRealmResolver` for the injection point
 * and `apps/api/src/middleware/realm-guard.ts` for the request-time
 * enforcement that consumes the resulting realm string.
 */

import { APIError } from "better-auth/api";
import { readPendingClientCookieFromHeaders } from "./pending-client-cookie.ts";
import { loadClientSignupPolicy } from "./orgmember-mapping.ts";

export async function oidcRealmResolver(headers: Headers | null): Promise<string> {
  const pendingClientId = readPendingClientCookieFromHeaders(headers);
  // No OIDC marker → genuine non-OIDC signup (core dashboard, invitation).
  if (!pendingClientId) return "platform";

  const policy = await loadClientSignupPolicy(pendingClientId);
  if (!policy) {
    // A signed cookie is present (intentional OIDC flow) but names an
    // unknown/disabled client — we cannot establish a coherent realm.
    // Fail closed rather than mint a platform-realm user for an OIDC flow.
    throw new APIError("FORBIDDEN", {
      message: "oidc_realm_unresolved",
      code: "oidc_realm_unresolved",
    });
  }
  // org / instance clients ARE platform audiences — their users are real
  // platform members. This is a legitimate `platform` resolution, not a
  // fallback.
  if (policy.level !== "application") return "platform";
  if (!policy.applicationId) {
    // Application-level client without an applicationId is a data-integrity
    // anomaly (the create schema requires `referenced_application_id`).
    // Refuse rather than downgrade an application flow to `platform`.
    throw new APIError("FORBIDDEN", {
      message: "oidc_realm_unresolved",
      code: "oidc_realm_unresolved",
    });
  }

  return `end_user:${policy.applicationId}`;
}
