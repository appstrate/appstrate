// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical scope vocabulary for the OIDC module.
 *
 * Kept dependency-free so the hot-path `scopesToPermissions` in `claims.ts`
 * doesn't pull Better Auth / oauth-provider / jose through a transitive
 * import when a core Bearer JWT request only needs to filter scopes.
 */

import { OIDC_ALLOWED_SCOPES } from "../../../lib/permissions.ts";

/**
 * OIDC protocol scopes that grant no Appstrate permission. Required by the
 * oauth-provider plugin (`openid`/`profile`/`email`) and by every standard
 * OIDC client library. `offline_access` gates refresh-token issuance.
 */
export const OIDC_IDENTITY_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

/** O(1) membership check on identity scopes — avoids re-materializing a Set per call. */
export const OIDC_IDENTITY_SCOPE_SET: ReadonlySet<string> = new Set(OIDC_IDENTITY_SCOPES);

/**
 * Canonical scope vocabulary served by the OIDC module. Identity scopes
 * first, then core `Permission` strings drawn from `OIDC_ALLOWED_SCOPES` —
 * no second vocabulary, no translation layer. The scope `agents:run`
 * grants the `agents:run` permission verbatim.
 *
 * The admin UI, the consent page, and `/.well-known/openid-configuration`
 * all read from this array via `GET /api/oauth/scopes`.
 */
export const APPSTRATE_SCOPES: readonly string[] = [
  ...OIDC_IDENTITY_SCOPES,
  ...OIDC_ALLOWED_SCOPES,
];
