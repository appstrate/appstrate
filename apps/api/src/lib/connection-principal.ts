// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { getActor, type Actor } from "./actor.ts";
import { unauthorized } from "./errors.ts";

/**
 * Who acts on connections, decided once at the door. A user principal acts as the person, whatever
 * the transport; any other credential is delegated: bound to its org, and to the space it pins
 * when it pins one. `X-Space-Id` addresses the request space and grants no binding.
 */
export type ConnectionPrincipal =
  | { kind: "person"; actor: Actor }
  | { kind: "delegated"; actor: Actor; orgId: string; spaceId: string | null };

export function connectionPrincipal(c: Context<AppEnv>): ConnectionPrincipal {
  const actor = getActor(c);
  if (c.get("principalKind") === "user") return { kind: "person", actor };
  const orgId = c.get("orgId");
  if (!orgId) throw unauthorized("Credential is missing its organization binding");
  return { kind: "delegated", actor, orgId, spaceId: c.get("credentialSpaceId") ?? null };
}

/** The space a delegated credential is confined to; `null`: a person or an unpinned credential. */
export function boundSpaceOf(principal: ConnectionPrincipal): string | null {
  return principal.kind === "delegated" ? principal.spaceId : null;
}

/** The shares of a connection `principal` sees: all of them, or only its bound space's. */
export function sharesSeenBy(principal: ConnectionPrincipal, shares: readonly string[]): string[] {
  const bound = boundSpaceOf(principal);
  return shares.filter((id) => bound === null || id === bound);
}
