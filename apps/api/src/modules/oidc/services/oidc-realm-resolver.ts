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
 *   - `"platform"` otherwise — covering org-level clients (whose users are
 *     real platform members auto-joined to the org), instance-level
 *     clients (satellite dashboards, themselves platform audiences), and
 *     the no-cookie case (direct dashboard signup, invitation flow).
 *
 * See `packages/db/src/auth.ts::setRealmResolver` for the injection point
 * and `apps/api/src/middleware/realm-guard.ts` for the request-time
 * enforcement that consumes the resulting realm string.
 */

import { readPendingClientCookieFromHeaders } from "./pending-client-cookie.ts";
import { loadClientSignupPolicy } from "./orgmember-mapping.ts";

export async function oidcRealmResolver(headers: Headers | null): Promise<string> {
  const pendingClientId = readPendingClientCookieFromHeaders(headers);
  if (!pendingClientId) return "platform";

  const policy = await loadClientSignupPolicy(pendingClientId);
  if (!policy) return "platform";
  if (policy.level !== "application") return "platform";
  if (!policy.applicationId) return "platform";

  return `end_user:${policy.applicationId}`;
}
