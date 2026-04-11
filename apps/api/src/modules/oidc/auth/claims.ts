// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth scope → Appstrate permission mapping.
 *
 * The oauth-provider plugin issues JWTs carrying a space-separated `scope`
 * claim. The OIDC auth strategy translates those scopes into the concrete
 * core Permission strings that `requirePermission()` checks against on every
 * route handler.
 *
 * We deliberately keep the mapping narrow in Phase 1: only scopes that map to
 * an existing core resource are honored. Unknown scopes are silently dropped
 * (they do not produce an error — the token may be valid for a different
 * embedding app's scope vocabulary).
 */

export function scopesToPermissions(scope?: string): Set<string> {
  const permissions = new Set<string>();
  if (!scope) return permissions;
  for (const s of scope.split(/\s+/)) {
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

      // Unknown scope — drop silently.
      default:
        break;
    }
  }
  return permissions;
}
