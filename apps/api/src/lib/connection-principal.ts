// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { getActor, type Actor } from "./actor.ts";
import { unauthorized } from "./errors.ts";
import { credentialConfinedToSpaces } from "./view-as.ts";

/**
 * Where a credential confines the caller on connections: one org, and within it the spaces it
 * names (`null`: every space of the org).
 */
interface ConnectionBinding {
  orgId: string;
  spaceIds: readonly string[] | null;
}

/**
 * Who acts on connections, decided once at the door. A user principal acts as the person, whatever
 * the transport; unbound (`binding: null`, every org the person belongs to) unless its credential is
 * confined (`credentialConfinedToSpaces`: a pin, an allowlist), which binds it to its org and the
 * spaces it names. An unpinned allowlist the person did not choose
 * (`credentialSpaceIdsRestricted === false`: an unlimited chat turn) binds to its org alone
 * (`spaceIds: null`): it reaches nothing of another org, and acts on connections of its org as the
 * person does. Any other credential is delegated: bound to its org, and to the space it pins when
 * it pins one. `X-Space-Id` addresses the request space and grants no binding.
 */
export type ConnectionPrincipal =
  | { kind: "person"; actor: Actor; binding: ConnectionBinding | null }
  | { kind: "delegated"; actor: Actor; binding: ConnectionBinding };

export function connectionPrincipal(c: Context<AppEnv>): ConnectionPrincipal {
  const actor = getActor(c);
  const isUser = c.get("principalKind") === "user";
  if (isUser && !credentialConfinedToSpaces(c)) {
    return { kind: "person", actor, binding: null };
  }
  const orgId = c.get("orgId");
  if (!orgId) throw unauthorized("Credential is missing its organization binding");
  const pinned = c.get("credentialSpaceId");
  const allowlist = c.get("credentialSpaceIds");
  // A pin and an allowlist both confine: the spaces both admit.
  const chosen = !isUser || pinned !== undefined || c.get("credentialSpaceIdsRestricted") !== false;
  const spaceIds =
    pinned && allowlist ? allowlist.filter((id) => id === pinned) : pinned ? [pinned] : allowlist;
  const binding = { orgId, spaceIds: chosen ? (spaceIds ?? null) : null };
  return c.get("principalKind") === "user"
    ? { kind: "person", actor, binding }
    : { kind: "delegated", actor, binding };
}

/** The spaces the principal is confined to; `null`: confined to none (a person, an unpinned credential). */
export function boundSpacesOf(principal: ConnectionPrincipal): readonly string[] | null {
  return principal.binding?.spaceIds ?? null;
}

/**
 * Whether a connection the principal writes is delegated, hence scoped to a space: a delegated
 * credential, or a person bound to spaces. The one scope rule of every connect door
 * (`writesOrgScope` reads it).
 */
export function writesDelegated(principal: ConnectionPrincipal): boolean {
  return principal.kind === "delegated" || boundSpacesOf(principal) !== null;
}
