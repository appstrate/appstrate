// SPDX-License-Identifier: Apache-2.0

/**
 * Where the platform decides WHO gets per-principal grants (RBAC spec §4.2).
 *
 * The mechanism itself — declaration registry, cache, invalidation — lives in
 * `@appstrate/core/principal-permissions` so a module can invalidate its own
 * writes. This file holds the one policy question that is the platform's:
 * which callers are eligible.
 *
 * Only session-shaped ones. A module may declare nothing but session-only
 * strings in `mayGrant` (the loader refuses anything API-key- or
 * end-user-grantable), so an API key's scope list and an OIDC scope claim
 * physically cannot contain a principal grant; resolving it for them would be
 * a lookup whose result the ceiling then discards. Strategies that set
 * `deferOrgResolution` behave like sessions — they resolve their org from
 * `X-Org-Id` and hold no scope ceiling of their own — so they are eligible too.
 */

import type { Context } from "hono";
import { resolvePrincipalPermissions } from "@appstrate/core/principal-permissions";
import type { OrgRole } from "@appstrate/core/permissions";
import { listedOrgPermissions } from "./permissions.ts";
import type { AppEnv } from "../types/index.ts";

const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * Extra org-level permissions this caller holds in `orgId` beyond its org
 * role, or the empty set when the caller is not session-shaped (or no module
 * declares the surface — the core resolver short-circuits then).
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
 * The `permissions` field an org LISTING exposes for one org — role grants,
 * this caller's per-principal grants in that org, ceiling applied.
 *
 * One helper for `GET /api/orgs` and `GET /api/me/orgs` so the two listings
 * cannot answer differently for the same caller.
 */
export async function listedOrgPermissionsForCaller(
  c: Context<AppEnv>,
  orgId: string,
  role: OrgRole,
): Promise<string[]> {
  return listedOrgPermissions(role, c.get("scopeCeiling"), await principalGrants(c, orgId));
}
