// SPDX-License-Identifier: Apache-2.0

/**
 * Org context for `/api/orgs/:orgId*`, where the org is in the PATH.
 *
 * That family skips `requireOrgContext` (`skipOrgContext`,
 * `lib/auth-pipeline.ts`), so the pipeline's permission step never runs for it
 * and this middleware IS that step. Mounted ONCE at the app root, ahead of the
 * orgs router and of every module router, so a module mounting under
 * `/api/orgs/:orgId/…` inherits it rather than deriving a second, ceiling-free
 * answer — which is exactly how an API key scoped to `runs:read` once reached
 * oidc's `cli-sessions` with its creator's full org authority.
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §4.2
 */

import type { Context, Next } from "hono";
import { forbidden } from "../lib/errors.ts";
import { apiKeyOrgScopeGuard } from "./guards.ts";
import { assertOrgRole, effectivePermissions, orgPermissions } from "../lib/permissions.ts";
import { principalGrants } from "../lib/principal-permissions.ts";
import { getOrgMember } from "../services/organizations.ts";
import type { AppEnv } from "../types/index.ts";

/**
 * Non-membership is `next()`, not a throw: the route's own guard decides the
 * status. The orgs router answers 403 from `requirePermission`, the oidc
 * cli-session routes from {@link requireOrgPathMembership}.
 */
async function orgPathContext(c: Context<AppEnv>, next: Next) {
  const orgId = c.req.param("orgId");
  if (!orgId) return next();

  // Every other auth method already wrote a CEILING-LIMITED set (API-key scopes
  // ∩ creator role, a token's scope claim) and keeps it; overwriting it with the
  // membership row's full role set is a privilege escalation.
  if (c.get("authMethod") !== "session" && !c.get("deferOrgResolution")) return next();

  const member = await getOrgMember(orgId, c.get("user").id);
  if (!member) return next();

  const role = assertOrgRole(member.role);
  // The two halves the pipeline unions for a session caller.
  const org = new Set<string>([...orgPermissions(role), ...(await principalGrants(c, orgId))]);
  c.set("orgId", orgId);
  c.set("orgRole", role);
  c.set("orgPermissions", org);
  // Never space-scoped, so the org half is the whole answer.
  c.set(
    "permissions",
    effectivePermissions({ orgPermissions: org, scopeCeiling: c.get("scopeCeiling") }),
  );
  return next();
}

/**
 * 403 on non-membership, for routes that want it before their permission guard
 * runs. Reads what `orgPathContext` wrote and derives nothing.
 */
export async function requireOrgPathMembership(c: Context<AppEnv>, next: Next) {
  const orgId = c.req.param("orgId");
  if (!orgId) throw forbidden("Not a member of this organization");
  if (c.get("orgRole") === undefined || c.get("orgId") !== orgId) {
    throw forbidden("Not a member of this organization");
  }
  return next();
}

/**
 * The chain, in order, as one value so `index.ts` and the test harness cannot
 * mount half of it. `apiKeyOrgScopeGuard` FIRST: a key bound to org A is
 * refused on `/api/orgs/B/...` before anything reads B's rows.
 */
export const ORG_PATH_MIDDLEWARE = [apiKeyOrgScopeGuard, orgPathContext] as const;
