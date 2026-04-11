// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth scope → Appstrate permission mapping.
 *
 * The oauth-provider plugin issues JWTs carrying a space-separated `scope`
 * claim. The OIDC auth strategy translates those scopes into the concrete
 * core Permission strings that `requirePermission()` checks against on every
 * route handler.
 *
 * Unknown scopes are dropped (they do not produce an error — the token may be
 * valid for a different embedding app's scope vocabulary) but emit a warn log
 * so operators can spot silent authorization drift when a satellite upgrades
 * its scope catalog faster than the platform.
 */

import { logger } from "../../../lib/logger.ts";

const KNOWN_SCOPES = [
  "openid",
  "profile",
  "email",
  "agents",
  "agents:write",
  "runs",
  "runs:write",
  "connections",
  "connections:write",
] as const;

export function scopesToPermissions(scope?: string): Set<string> {
  const permissions = new Set<string>();
  if (!scope) return permissions;
  for (const s of scope.split(/\s+/)) {
    if (s === "") continue;
    switch (s) {
      // Identity scopes — no resource permission.
      case "openid":
      case "profile":
      case "email":
        break;

      case "agents":
        permissions.add("agents:read");
        break;
      case "agents:write":
        permissions.add("agents:read");
        permissions.add("agents:run");
        break;

      case "runs":
        permissions.add("runs:read");
        break;
      case "runs:write":
        permissions.add("runs:read");
        permissions.add("runs:cancel");
        break;

      case "connections":
        permissions.add("connections:read");
        break;
      case "connections:write":
        permissions.add("connections:read");
        permissions.add("connections:connect");
        permissions.add("connections:disconnect");
        break;

      default:
        logger.warn(
          "oidc: unknown OAuth scope dropped — token carries a scope not recognized by core permissions",
          { module: "oidc", scope: s, knownScopes: KNOWN_SCOPES as unknown as string[] },
        );
        break;
    }
  }
  return permissions;
}
