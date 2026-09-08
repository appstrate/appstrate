// SPDX-License-Identifier: Apache-2.0

/**
 * Org context for `/api/orgs/:orgId*` (org in the PATH). That family skips
 * `requireOrgContext`, so this middleware IS the permission step. Mounted ONCE
 * at the app root so every router under `/api/orgs/:orgId/…`, modules included,
 * inherits it instead of deriving a ceiling-free answer (RBAC spec §4.2).
 */

import type { Context, Next } from "hono";
import { forbidden } from "../lib/errors.ts";
import { apiKeyOrgScopeGuard } from "./guards.ts";
import { orgHalfFor, resolveViewAs } from "../lib/view-as.ts";
import { principalGrants } from "../lib/principal-permissions.ts";
import { getOrgMember } from "../services/organizations.ts";
import type { AppEnv } from "../types/index.ts";

/** Non-membership is `next()`, not a throw: the route's own guard decides the status. */
async function orgPathContext(c: Context<AppEnv>, next: Next) {
  const orgId = c.req.param("orgId");
  if (!orgId) return next();

  // A pinned org wins over the path (as over `X-Org-Id` in `requireOrgContext`)
  // and is checked for EVERY credential: a token scoped to org A must not reach
  // org B by naming it in the URL.
  const pinned = c.get("orgId");
  if (pinned && pinned !== orgId) {
    throw forbidden("Path organization does not match authenticated organization");
  }

  // Non-session methods already hold a CEILING-LIMITED set; overwriting it with
  // the membership row's full role set would be a privilege escalation.
  if (c.get("authMethod") !== "session" && !c.get("deferOrgResolution")) return next();

  const member = await getOrgMember(orgId, c.get("user").id);
  if (!member) return next();

  const role = member.role;
  // After the real org role, before the single `permissions` write.
  await resolveViewAs(c, orgId, role);
  // Never space-scoped, so the org half is the whole answer.
  const { orgPermissions, effective } = orgHalfFor(c, orgId, role, await principalGrants(c, orgId));
  c.set("orgId", orgId);
  c.set("orgRole", role);
  c.set("orgPermissions", orgPermissions);
  c.set("permissions", effective);
  return next();
}

/** 403 on non-membership, ahead of a route's permission guard. Reads what `orgPathContext` wrote. */
export async function requireOrgPathMembership(c: Context<AppEnv>, next: Next) {
  const orgId = c.req.param("orgId");
  if (!orgId) throw forbidden("Not a member of this organization");
  if (c.get("orgRole") === undefined || c.get("orgId") !== orgId) {
    throw forbidden("Not a member of this organization");
  }
  return next();
}

/**
 * One value so `index.ts` and the test harness cannot mount half the chain.
 * `apiKeyOrgScopeGuard` FIRST: a key bound to org A is refused on `/api/orgs/B`
 * before anything reads B's rows.
 */
export const ORG_PATH_MIDDLEWARE = [apiKeyOrgScopeGuard, orgPathContext] as const;
