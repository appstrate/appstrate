// SPDX-License-Identifier: Apache-2.0

/**
 * WHO is eligible for per-principal grants (RBAC spec §4.2); the mechanism is
 * `@appstrate/core/principal-permissions`.
 */

import type { Context } from "hono";
import { resolvePrincipalPermissions } from "@appstrate/core/principal-permissions";
import { getUserOrganizations } from "../services/organizations.ts";
import { unauthorized } from "./errors.ts";
import { orgHalfFor, personaFor, resolveListingViewAs } from "./view-as.ts";
import { isUserPrincipal } from "./principal.ts";
import type { AppEnv } from "../types/index.ts";

const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * Per-principal grants belong to the human (RBAC spec §4.1: `orgPermissions = role set ∪ module
 * grants ∪ principalPermissions(user, org)`), so a `user` principal takes them by any transport.
 * A delegate's ceiling (`scopes ∩ …`) never holds a `mayGrant` string, so skipping the lookup for
 * it changes nothing but the query.
 */
export async function principalGrants(
  c: Context<AppEnv>,
  orgId: string | undefined,
): Promise<ReadonlySet<string>> {
  if (!orgId) return EMPTY;
  if (!isUserPrincipal(c)) return EMPTY;
  return resolvePrincipalPermissions({ orgId, userId: c.get("user").id });
}

/**
 * One answer for `GET /api/orgs` and `GET /api/me/orgs`: the persona validated
 * by `resolveListingViewAs` applies to its own org only, every other row is the
 * caller's real standing.
 */
export async function listCallerOrganizations(c: Context<AppEnv>) {
  const user = c.get("user");
  if (!user) throw unauthorized("Authentication required");
  const delegate = !isUserPrincipal(c);
  const orgId = c.get("orgId");
  if (delegate && !orgId) throw unauthorized("Credential is missing its organization binding");
  const orgs = await getUserOrganizations(user.id, delegate ? orgId : undefined);
  await resolveListingViewAs(c, orgs);
  return Promise.all(
    orgs.map(async (org) => {
      const granted = await principalGrants(c, org.id);
      return {
        id: org.id,
        name: org.name,
        slug: org.slug,
        icon: org.icon,
        color: org.color,
        role: personaFor(c, org.id)?.orgRole ?? org.role,
        permissions: [...orgHalfFor(c, org.id, org.role, granted).effective].sort(),
        createdAt: org.createdAt,
        deleting_at: org.deletingAt,
      };
    }),
  );
}
