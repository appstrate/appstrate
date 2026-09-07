// SPDX-License-Identifier: Apache-2.0

/**
 * WHO is eligible for per-principal grants (RBAC spec §4.2); the mechanism is
 * `@appstrate/core/principal-permissions`.
 */

import type { Context } from "hono";
import { resolvePrincipalPermissions } from "@appstrate/core/principal-permissions";
import type { OrgRole } from "@appstrate/core/permissions";
import { orgHalfFor, personaFor } from "./view-as.ts";
import type { AppEnv } from "../types/index.ts";

const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * Session-shaped callers only: `mayGrant` holds session-only strings, and a
 * `deferOrgResolution` strategy has no ceiling of its own, so it counts as one.
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
 * One answer for `GET /api/orgs` and `GET /api/me/orgs`: the persona validated
 * by `resolveListingViewAs` applies to its own org only, every other row is the
 * caller's real standing.
 */
export async function listedOrgIdentityForCaller(
  c: Context<AppEnv>,
  orgId: string,
  role: OrgRole,
): Promise<{ role: OrgRole; permissions: string[] }> {
  const granted = await principalGrants(c, orgId);
  return {
    role: personaFor(c, orgId)?.orgRole ?? role,
    permissions: [...orgHalfFor(c, orgId, role, granted).effective].sort(),
  };
}
