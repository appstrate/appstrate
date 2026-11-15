// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { listSpacesForPrincipal } from "../services/spaces.ts";
import type { Permission } from "./permissions.ts";
import type { SpaceRoleRef } from "./space-role.ts";
import {
  callerOrgRole,
  callerPersonalOwnerId,
  effectiveInSpace,
  personaFor,
  personaMemberships,
} from "./view-as.ts";

/** A space the caller holds a role in, with their effective set there. */
export interface ReachableSpace {
  id: string;
  name: string;
  role: SpaceRoleRef;
  permissions: Set<Permission>;
}

/**
 * The spaces of `GET /api/spaces` where the caller holds a role (persona
 * overlay included), for every read that spans spaces. A space listed without
 * one — a `closed` space not joined, an orphaned personal space shown to admins
 * — is not reached; a principal without an org role reaches none, and a
 * credential pinned to a space reaches that space only.
 */
export async function callerReachableSpaces(
  c: Context<AppEnv>,
  orgId: string,
): Promise<ReachableSpace[]> {
  const orgRole = callerOrgRole(c, orgId);
  if (!orgRole) return [];
  const entries = await listSpacesForPrincipal(
    orgId,
    orgRole,
    c.get("user").id,
    callerPersonalOwnerId(c, orgId),
    personaMemberships(personaFor(c, orgId)),
  );
  const pinned = c.get("spaceId");
  return entries.flatMap(({ space, role }) =>
    role && (!pinned || space.id === pinned)
      ? [{ id: space.id, name: space.name, role, permissions: effectiveInSpace(c, role) }]
      : [],
  );
}
