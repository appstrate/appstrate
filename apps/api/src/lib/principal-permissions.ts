// SPDX-License-Identifier: Apache-2.0

/**
 * WHO is eligible for per-principal grants (RBAC spec §4.2). The mechanism —
 * registry, cache, invalidation — is `@appstrate/core/principal-permissions`.
 */

import type { Context } from "hono";
import { resolvePrincipalPermissions } from "@appstrate/core/principal-permissions";
import type { OrgRole } from "@appstrate/core/permissions";
import { listedOrgPermissions } from "./permissions.ts";
import { orgHalfFor, personaFor } from "./view-as.ts";
import type { AppEnv } from "../types/index.ts";

const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * Extra org-level permissions this caller holds in `orgId`, beyond its org role.
 *
 * Session-shaped only: `mayGrant` may hold nothing but session-only strings, so
 * a delegated credential's ceiling could not carry the answer anyway.
 * `deferOrgResolution` strategies hold no ceiling of their own and count as
 * sessions.
 */
export async function principalGrants(
  c: Context<AppEnv>,
  orgId: string | undefined,
): Promise<ReadonlySet<string>> {
  if (!orgId) return EMPTY;
  if (c.get("authMethod") !== "session" && !c.get("deferOrgResolution")) return EMPTY;
  return resolvePrincipalPermissions({ orgId, userId: c.get("user").id });
}

/**
 * What an org LISTING says about the caller in one org: their role, and the
 * `permissions` it grants — role grants ∪ principal grants, ceiling applied.
 * One helper for `GET /api/orgs` and `GET /api/me/orgs` so the two cannot
 * answer differently for the same caller.
 *
 * The persona, if any, was validated once for the whole listing by
 * `resolveListingViewAs` and applies to its own org only; every other row is
 * the caller's real standing.
 */
export async function listedOrgIdentityForCaller(
  c: Context<AppEnv>,
  orgId: string,
  role: OrgRole,
): Promise<{ role: OrgRole; permissions: string[] }> {
  const granted = await principalGrants(c, orgId);
  const persona = personaFor(c, orgId);
  if (!persona) {
    return { role, permissions: listedOrgPermissions(role, c.get("scopeCeiling"), granted) };
  }
  return {
    role: persona.orgRole,
    permissions: [...orgHalfFor(c, orgId, role, granted).effective].sort(),
  };
}
