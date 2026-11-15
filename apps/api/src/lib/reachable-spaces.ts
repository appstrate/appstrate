// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { listSpacesForPrincipal } from "../services/spaces.ts";
import type { Permission } from "./permissions.ts";
import type { SpaceRoleRef } from "./space-role.ts";
import { forbidden, invalidRequest } from "./errors.ts";
import {
  callerOrgRole,
  callerPersonalOwnerId,
  effectiveInSpace,
  personaFor,
  personaMemberships,
} from "./view-as.ts";

/** A space the caller holds a role in, with their effective set there. */
interface ReachableSpace {
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

/**
 * The preamble of every list spanning the spaces of `orgId`: the caller's
 * reach, narrowed by `spaceIdParam` (the `spaceId` query value, comma-separated
 * ids), kept where the effective set `admits` the list. A space reached but not
 * admitting it contributes no row; an id outside the reach is a 400, one answer
 * for a space that does not exist and one not reached, so it discloses nothing.
 * Empty segments are dropped and an empty value reads as absent, as on every
 * closed-set filter. An end-user acts in its own space only (RBAC spec §7.2),
 * so it is refused — before the route reads any other query parameter.
 */
export async function readableSpacesAcross(
  c: Context<AppEnv>,
  orgId: string,
  spaceIdParam: string | undefined,
  admits: (permissions: ReadonlySet<Permission>) => boolean,
): Promise<ReachableSpace[]> {
  if (c.get("principalKind") === "end_user") {
    throw forbidden("An end-user cannot list across spaces");
  }
  const reachable = await callerReachableSpaces(c, orgId);
  const ids = (spaceIdParam ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const requested = ids.length ? ids : undefined;
  const unknown = requested?.find((id) => !reachable.some((space) => space.id === id));
  if (unknown !== undefined) {
    throw invalidRequest(`spaceId names a space you do not reach: ${unknown}`, "spaceId");
  }
  return reachable.filter(
    (space) => (!requested || requested.includes(space.id)) && admits(space.permissions),
  );
}
