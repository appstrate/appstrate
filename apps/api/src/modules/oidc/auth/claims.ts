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

import { getModuleEndUserAllowedScopes, type OrgRole } from "@appstrate/core/permissions";
import { resolvePermissions } from "../../../lib/permissions.ts";
import { logger } from "../../../lib/logger.ts";
import { OIDC_ALLOWED_SCOPES, OIDC_IDENTITY_SCOPE_SET } from "./scopes.ts";

type ActorType = "dashboard_user" | "end_user" | "user";

/**
 * Runtime membership check against the safe end-user allowlist —
 * `OIDC_ALLOWED_SCOPES` (core-owned built-in surface) ∪ module
 * contributions opted in via `permissionsContribution({ endUserGrantable: true })`.
 *
 * Returns `boolean` (not a type predicate) because the consumer at this
 * layer treats permissions as opaque `string`s: the granted set flows
 * into `AuthResolution.permissions: readonly string[]`, then into
 * `c.set("permissions", Set<string>)`. Strong typing kicks back in at
 * the apps/api guard sites (`requirePermission(resource, action)`)
 * which key on the `Resource`/`Action` discriminated union — keeping
 * this file ignorant of that union avoids coupling the OIDC module to
 * apps/api's `Permission` type.
 *
 * Module surface read on every call (no caching): the snapshot is
 * computed once at boot, so the lookup is a single `Set.has` — the
 * indirection is free, and a stale cache would mask test-time module
 * resets (`resetModules` clears the provider).
 */
function isAllowedOidcScope(s: string): boolean {
  if ((OIDC_ALLOWED_SCOPES as ReadonlySet<string>).has(s)) return true;
  return getModuleEndUserAllowedScopes().has(s);
}

export function scopesToPermissions(
  scope: string | undefined,
  actorType: ActorType,
  orgRole?: OrgRole,
): Set<string> {
  const granted = new Set<string>();
  if (!scope) return granted;

  // Instance-level tokens ("user") defer permission resolution to the
  // auth pipeline — permissions are derived from orgRole after the
  // X-Org-Id middleware resolves org context. Return empty set here.
  if (actorType === "user") return granted;

  // Dashboard users: the role's permission set is the ceiling. A scope is
  // granted iff the role allows it. This prevents token privilege
  // escalation after a role downgrade and matches the way API keys derive
  // their effective permissions (see `resolveApiKeyPermissions`).
  const ceiling: ReadonlySet<string> | undefined =
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
        logger.debug(
          "oidc: end_user scope dropped (not in OIDC_ALLOWED_SCOPES nor a module endUserGrantable contribution)",
          { module: "oidc", scope: s },
        );
      }
      continue;
    }
    // Dashboard flow: scope must be present in the role's ceiling set.
    if (ceiling && ceiling.has(s)) {
      granted.add(s);
      continue;
    }
    logger.debug("oidc: dashboard scope dropped — role ceiling does not allow it", {
      module: "oidc",
      scope: s,
      orgRole,
    });
  }
  return granted;
}
