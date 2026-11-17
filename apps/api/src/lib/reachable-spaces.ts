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
  /** Whether the space lets an MCP caller reach the credential proxy outside a run. */
  credentialProxyOpen: boolean;
  role: SpaceRoleRef;
  permissions: Set<Permission>;
}

/**
 * The spaces where the caller holds a role (persona overlay included): the reach of every read
 * spanning spaces and of `packageAccessSpaces`. A request pinned to a space (its credential or
 * `dispatchSpacePin`) reaches that space only.
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
            credentialProxyOpen: space.credentialProxyOpen,
            role,
            permissions: effectiveInSpace(c, role),
          },
        ]
      : [],
  );
}

/**
 * The preamble of every list spanning the spaces of `orgId`: one grant per reached space whose
 * effective set grants one of `permissions`. An end-user acts in its own space only, so it is
 * refused before the route reads any query parameter.
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
