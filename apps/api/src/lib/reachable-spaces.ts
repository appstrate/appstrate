// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { OrgRole, SpaceRolePreset, SpaceVisibility } from "@appstrate/core/permissions";
import type { AppEnv } from "../types/index.ts";
import { listSpacesForPrincipal } from "../services/spaces.ts";
import type { Permission, SpaceGrant } from "./permissions.ts";
import { toSpaceRoleWire, type SpaceRoleRef } from "./space-role.ts";
import { forbidden, notFound, type ApiError } from "./errors.ts";
import { dispatchSpacePin } from "./internal-dispatch.ts";
import {
  callerOrgRole,
  callerPersonalOwnerId,
  credentialAdmitsSpace,
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
 * spanning spaces and of `packageAccessSpaces`. A request pinned to a space (its credential, a
 * pinned dispatch, the space-pinned MCP endpoint) reaches that space only; a credential bound to a SET of spaces
 * (`credentialSpaceIds`) reaches those alone. A read crossing into another organization names
 * `orgRole`.
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
  const key = `${orgId}:${orgRole}:${spacePin(c) ?? ""}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = resolveReachableSpaces(c, orgId, orgRole);
  cache.set(key, pending);
  return pending;
}

/** The space this request is confined to by its door: a pinned dispatch or endpoint. */
function spacePin(c: Context<AppEnv>): string | undefined {
  return dispatchSpacePin(c) ?? c.get("endpointSpaceId");
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
  const pin = spacePin(c);
  return entries.flatMap(({ space, role }) =>
    role && credentialAdmitsSpace(c, space.id) && (!pin || space.id === pin)
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

/** A reachable space as the wire names it: the role by its wire name, the set as an array. */
export function toReachableSpaceWire(space: ReachableSpace) {
  return {
    id: space.id,
    name: space.name,
    role: toSpaceRoleWire(space.role)!.name,
    permissions: [...space.permissions],
    credentialProxyOpen: space.credentialProxyOpen,
  };
}

/**
 * The caller's reach for a route that serves the organization as a whole: the
 * spaces of {@link callerReachableSpaces}, after refusing an end-user — it acts
 * in its own space only (RBAC spec §7.2), so it is refused before the route
 * reads any query parameter.
 */
export async function reachAcrossSpaces(
  c: Context<AppEnv>,
  orgId: string,
): Promise<ReachableSpace[]> {
  if (c.get("principalKind") === "end_user") {
    throw forbidden("An end-user cannot list across spaces");
  }
  return callerReachableSpaces(c, orgId);
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
  const reachable = await reachAcrossSpaces(c, orgId);
  return reachable.flatMap((space) =>
    permissions.some((permission) => space.permissions.has(permission))
      ? [{ spaceId: space.id, permissions: space.permissions }]
      : [],
  );
}

/**
 * The refusal for a space the request's credential may not name (`credentialAdmitsSpace`). It
 * depends on the credential alone, never on the space, so it confirms nothing about an id. A
 * credential pinned to one space is told what it already knows, a 403 (the contract of API keys
 * and space-bound tokens); a credential bound to a SET of spaces gets the 404 a space
 * outside its reach gets everywhere else (`enterSpaceById`), so the set is not probed by status.
 * `spaceId` is `null` for a personal space the request would create.
 */
export function unnameableSpace(c: Context<AppEnv>, spaceId: string | null): ApiError {
  if (c.get("credentialSpaceId") !== undefined) {
    return forbidden("Credential scope does not include this space");
  }
  return notFound(
    spaceId ? `Space '${spaceId}' not found in this organization` : "Space not found",
  );
}
