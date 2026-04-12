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

import { resolvePermissions, type Permission } from "../../../lib/permissions.ts";
import { logger } from "../../../lib/logger.ts";
import type { OrgRole } from "../../../types/index.ts";
import { OIDC_ALLOWED_SCOPES, OIDC_IDENTITY_SCOPE_SET } from "./scopes.ts";

type ActorType = "dashboard_user" | "end_user" | "user";

/**
 * Runtime-validated narrowing from `string` to `Permission`.
 *
 * `OIDC_ALLOWED_SCOPES` is typed as `ReadonlySet<Permission>`, so a
 * membership check is sufficient evidence that the input is a valid
 * `Permission`. Declaring this as a type predicate gives us a single
 * documented widening point instead of sprinkling `as Permission` casts
 * across the loop body — a reviewer can audit one function instead of
 * every call site, and any future change to `OIDC_ALLOWED_SCOPES` is
 * reflected here automatically.
 */
function isAllowedOidcScope(s: string): s is Permission {
  return (OIDC_ALLOWED_SCOPES as ReadonlySet<string>).has(s);
}

/** Runtime-validated narrowing through a role-ceiling Set<Permission>. */
function isWithinCeiling(s: string, ceiling: ReadonlySet<Permission>): s is Permission {
  return (ceiling as ReadonlySet<string>).has(s);
}

export function scopesToPermissions(
  scope: string | undefined,
  actorType: ActorType,
  orgRole?: OrgRole,
): Set<Permission> {
  const granted = new Set<Permission>();
  if (!scope) return granted;

  // Instance-level tokens ("user") defer permission resolution to the
  // auth pipeline — permissions are derived from orgRole after the
  // X-Org-Id middleware resolves org context. Return empty set here.
  if (actorType === "user") return granted;

  // Dashboard users: the role's permission set is the ceiling. A scope is
  // granted iff the role allows it. This prevents token privilege
  // escalation after a role downgrade and matches the way API keys derive
  // their effective permissions (see `resolveApiKeyPermissions`).
  const ceiling: ReadonlySet<Permission> | undefined =
    actorType === "dashboard_user" && orgRole ? resolvePermissions(orgRole) : undefined;

  // Safety alarm: a dashboard token without an `orgRole` gets zero scopes
  // below (ceiling is `undefined`, every scope falls through to the
  // "dropped" branch). The AuthResolution still looks legitimate — correct
  // user + orgId + authMethod — so every downstream request fails with an
  // opaque 403. Emit a dedicated warning up-front so operators can
  // distinguish this wiring bug from a legitimate role-downgrade drop.
  if (actorType === "dashboard_user" && !orgRole) {
    logger.warn(
      "oidc: dashboard_user token missing orgRole — all non-identity scopes will be dropped",
      { module: "oidc", actorType },
    );
  }

  for (const s of scope.split(/\s+/)) {
    if (s === "" || OIDC_IDENTITY_SCOPE_SET.has(s)) continue;
    if (actorType === "end_user") {
      // End-users are constrained to the safe OIDC allowlist. Anything
      // outside it (admin / destructive / org management) is dropped
      // silently — they should never have been requested in the first
      // place (the client creation API rejects them upfront).
      if (isAllowedOidcScope(s)) {
        granted.add(s);
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
    if (ceiling && isWithinCeiling(s, ceiling)) {
      granted.add(s);
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
