// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth scope → Appstrate permission filter.
 *
 * Polymorphic on the token `actor_type`. Dashboard tokens additionally filter
 * scopes through the current `org_role` so a `member` cannot escalate to
 * `admin`-level permissions even if the granted scope set was broader at
 * client-registration time. End-user tokens filter through a fixed safe
 * allowlist (destructive admin scopes are never reachable via the embedding
 * app flow).
 *
 * Convention: `{resource}:{action}` for every non-identity scope. The scope
 * string `agents:run` grants the `agents:run` permission verbatim — no
 * translation layer.
 */

import {
  OIDC_ALLOWED_SCOPES,
  resolvePermissions,
  type Permission,
} from "../../../lib/permissions.ts";
import { logger } from "../../../lib/logger.ts";
import type { OrgRole } from "../../../types/index.ts";
import { OIDC_IDENTITY_SCOPE_SET } from "./scopes.ts";

type ActorType = "dashboard_user" | "end_user";

export function scopesToPermissions(
  scope: string | undefined,
  actorType: ActorType,
  orgRole?: OrgRole,
): Set<Permission> {
  const granted = new Set<Permission>();
  if (!scope) return granted;

  // Dashboard users: the role's permission set is the ceiling. A scope is
  // granted iff the role allows it. This prevents token privilege
  // escalation after a role downgrade and matches the way API keys derive
  // their effective permissions (see `resolveApiKeyPermissions`).
  const ceiling =
    actorType === "dashboard_user" && orgRole ? resolvePermissions(orgRole) : undefined;

  // Widen to Set<string> for runtime .has() checks — the sets contain
  // Permission values, so a successful .has(s) guarantees s is a valid
  // Permission and the cast on .add() is safe.
  const allowedScopes = OIDC_ALLOWED_SCOPES as ReadonlySet<string>;
  const ceilingScopes = ceiling as ReadonlySet<string> | undefined;

  for (const s of scope.split(/\s+/)) {
    if (s === "" || OIDC_IDENTITY_SCOPE_SET.has(s)) continue;
    if (actorType === "end_user") {
      // End-users are constrained to the safe OIDC allowlist. Anything
      // outside it (admin / destructive / org management) is dropped
      // silently — they should never have been requested in the first
      // place (the client creation API rejects them upfront).
      if (allowedScopes.has(s)) {
        granted.add(s as Permission);
      } else {
        logger.warn("oidc: end_user scope dropped (not in OIDC_ALLOWED_SCOPES)", {
          module: "oidc",
          scope: s,
        });
      }
      continue;
    }
    // Dashboard flow: scope must be a valid Permission AND the role must
    // allow it (ceiling filter).
    if (ceilingScopes && ceilingScopes.has(s)) {
      granted.add(s as Permission);
      continue;
    }
    logger.warn("oidc: dashboard scope dropped — role ceiling does not allow it", {
      module: "oidc",
      scope: s,
      orgRole,
    });
  }
  return granted;
}
