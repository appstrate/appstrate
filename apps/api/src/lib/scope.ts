// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { internalError } from "./errors.ts";
import type { AppEnv } from "../types/index.ts";

/**
 * Scope objects for multi-tenant DB queries. Carried through the service
 * layer so every DB access is explicitly scoped at the type level.
 *
 * Why: issue #172 and its 4 sibling bugs all shared the same root cause —
 * a service filtered by `orgId` only, while the resource actually lived
 * under a `spaceId`. A key in Space A could therefore reach Space B
 * rows in the same org. Making space-scoped services take `SpaceScope` (which
 * structurally requires both fields) turns the "forgot to pass
 * spaceId" bug class into a TypeScript error at the call site.
 *
 * These types are intentionally not branded. The required `spaceId`
 * field on `SpaceScope` is the constraint — you cannot construct an
 * `SpaceScope` without it, which is enough to block the bug class. Branding
 * would add stronger guarantees (can't pass an ad-hoc `{ orgId, spaceId }`
 * object from outside the helpers) but at significant ergonomics cost.
 */

export interface OrgScope {
  readonly orgId: string;
}

export interface SpaceScope extends OrgScope {
  readonly spaceId: string;
}

/**
 * Space-scoped access WITHOUT an org boundary — the actor-ownership case.
 *
 * `/me/*` connection management operates purely on `(userId | endUserId)`
 * ownership: a connection belongs to its owner regardless of which org the
 * caller is currently scoped to (or whether they have an org context at all,
 * as with a cookie session). It carries the `spaceId` re-derived from the
 * resource row but deliberately NO `orgId`, so a consuming service can tell it
 * apart from an {@link SpaceScope} at the type level (`"orgId" in scope`) and skip
 * the space∈org escalation guard that only makes sense with an org. This replaces
 * the old `{ orgId: "" }` sentinel — the actor boundary is now expressed by the
 * absence of `orgId`, not a magic empty string.
 */
export interface ActorScope {
  readonly spaceId: string;
}

/**
 * Read `orgId` from the Hono context. The request has already passed the
 * org-context middleware so `orgId` is guaranteed to be present; throwing
 * here means a route skipped the middleware chain — a bug, not a runtime
 * condition the caller should handle.
 */
export function getOrgScope(c: Context<AppEnv>): OrgScope {
  const orgId = c.get("orgId");
  if (!orgId) {
    throw internalError();
  }
  return { orgId };
}

/**
 * Read `orgId` + `spaceId` from the Hono context. Routes that call
 * this MUST be mounted behind `requireSpaceContext()` (or the path must
 * satisfy `isSpaceScopedPath` / a module's space-scoped paths) so
 * `spaceId` is pinned before this runs. Throwing indicates a
 * misconfigured route — not something the caller should handle.
 */
export function getSpaceScope(c: Context<AppEnv>): SpaceScope {
  const orgId = c.get("orgId");
  const spaceId = c.get("spaceId");
  if (!orgId || !spaceId) {
    throw internalError();
  }
  return { orgId, spaceId };
}
