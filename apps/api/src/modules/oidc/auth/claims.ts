// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth scope → Appstrate permission filter.
 *
 * The oauth-provider plugin issues JWTs carrying a space-separated `scope`
 * claim. Every scope value is either an OIDC identity scope (openid /
 * profile / email / offline_access — no permission) or a core `Permission`
 * string drawn from `OIDC_ALLOWED_SCOPES` (used verbatim — no translation).
 *
 * Unknown scopes (not in either set) are dropped with a warn log so
 * operators can spot silent authorization drift when a satellite upgrades
 * its scope catalog faster than the platform.
 */

import { logger } from "../../../lib/logger.ts";
import { OIDC_ALLOWED_SCOPES, type Permission } from "../../../lib/permissions.ts";
import { OIDC_IDENTITY_SCOPES } from "./plugins.ts";

const IDENTITY = new Set<string>(OIDC_IDENTITY_SCOPES);

export function scopesToPermissions(scope?: string): Set<Permission> {
  const permissions = new Set<Permission>();
  if (!scope) return permissions;
  for (const s of scope.split(/\s+/)) {
    if (s === "" || IDENTITY.has(s)) continue;
    if (OIDC_ALLOWED_SCOPES.has(s as Permission)) {
      permissions.add(s as Permission);
      continue;
    }
    logger.warn(
      "oidc: unknown OAuth scope dropped — token carries a scope not in OIDC_ALLOWED_SCOPES",
      { module: "oidc", scope: s },
    );
  }
  return permissions;
}
