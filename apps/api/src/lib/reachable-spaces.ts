// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { OrgRole, SpaceRolePreset, SpaceVisibility } from "@appstrate/core/permissions";
import type { AppEnv } from "../types/index.ts";
import { listSpacesForPrincipal } from "../services/spaces.ts";
import type { Permission, SpaceGrant } from "./permissions.ts";
import type { SpaceRoleRef } from "./space-role.ts";
import { forbidden } from "./errors.ts";
import { dispatchSpacePin } from "./internal-dispatch.ts";
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
  isDefault: boolean;
  visibility: SpaceVisibility;
  defaultRole: SpaceRolePreset;
  ownerUserId: string | null;
  role: SpaceRoleRef;
  permissions: Set<Permission>;
}

/**
 * The spaces of `GET /api/spaces` where the caller holds a role (persona
 * overlay included), in that listing's order, for every read that spans spaces
 * and for the package reach (`packageAccessSpaces`). A space listed without one
 * — a `closed` space not joined, an orphaned personal space shown to admins —
 * is not reached; a principal without an org role reaches none, and a
 * request pinned to a space reaches that space only: by its credential
 * (`credentialSpaceId`: a space API key, a space-bound token), else by the
 * space-pinned MCP endpoint dispatching it (`dispatchSpacePin`).
 *
 * `orgRole` is the caller's role in `orgId`, read off the request by default; a
 * read crossing into another organization names it (`ForeignOrgStanding`).
 */
export function callerReachableSpaces(
  c: Context<AppEnv>,
  orgId: string,
  orgRole: OrgRole | undefined = callerOrgRole(c, orgId),
): Promise<ReachableSpace[]> {
  // Memoized per request, so a list spanning spaces and the package reach it
  // also reads (`packageAccessSpaces`) resolve it once. Keyed on the org AND
  // the role: one request can ask about two organizations.
  const cache = c.get("reachableSpacesCache") ?? new Map<string, Promise<ReachableSpace[]>>();
  if (!c.get("reachableSpacesCache")) c.set("reachableSpacesCache", cache);
  const key = `${orgId}:${orgRole}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = resolveReachableSpaces(c, orgId, orgRole);
  cache.set(key, pending);
  return pending;
}

/** The read itself — {@link callerReachableSpaces} is the memo in front of it. */
async function resolveReachableSpaces(
  c: Context<AppEnv>,
  orgId: string,
  orgRole: OrgRole | undefined,
): Promise<ReachableSpace[]> {
  if (!orgRole) return [];
  const entries = await listSpacesForPrincipal(
    orgId,
    orgRole,
    c.get("user").id,
    callerPersonalOwnerId(c, orgId),
    personaMemberships(personaFor(c, orgId)),
  );
  const pinned = c.get("credentialSpaceId") ?? dispatchSpacePin(c);
  return entries.flatMap(({ space, role }) =>
    role && (!pinned || space.id === pinned)
      ? [
          {
            id: space.id,
            name: space.name,
            isDefault: space.isDefault,
            visibility: space.visibility,
            defaultRole: space.defaultRole,
            ownerUserId: space.ownerUserId,
            role,
            permissions: effectiveInSpace(c, role),
          },
        ]
      : [],
  );
}

/**
 * The preamble of every list spanning the spaces of `orgId`: the caller's
 * reach, kept where the effective set grants one of `permissions` (the list's
 * read permission — the same list its route caps the credential with), as one
 * grant per space. A space reached but not admitting the list contributes no
 * row. An end-user acts in its own space only (RBAC spec §7.2), so it is
 * refused — before the route reads any query parameter.
 */
export async function readableSpacesAcross(
  c: Context<AppEnv>,
  orgId: string,
  permissions: readonly Permission[],
): Promise<SpaceGrant[]> {
  if (c.get("principalKind") === "end_user") {
    throw forbidden("An end-user cannot list across spaces");
  }
  const reachable = await callerReachableSpaces(c, orgId);
  return reachable.flatMap((space) =>
    permissions.some((permission) => space.permissions.has(permission))
      ? [{ spaceId: space.id, permissions: space.permissions }]
      : [],
  );
}
