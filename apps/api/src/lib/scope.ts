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
 * under an `applicationId`. A key in App A could therefore reach App B
 * rows in the same org. Making app-scoped services take `AppScope` (which
 * structurally requires both fields) turns the "forgot to pass
 * applicationId" bug class into a TypeScript error at the call site.
 *
 * These types are intentionally not branded. The required `applicationId`
 * field on `AppScope` is the constraint — you cannot construct an
 * `AppScope` without it, which is enough to block the bug class. Branding
 * would add stronger guarantees (can't pass an ad-hoc `{ orgId, applicationId }`
 * object from outside the helpers) but at significant ergonomics cost.
 */

export interface OrgScope {
  readonly orgId: string;
}

export interface AppScope extends OrgScope {
  readonly applicationId: string;
}

/**
 * App-scoped access WITHOUT an org boundary — the actor-ownership case.
 *
 * `/me/*` connection management operates purely on `(userId | endUserId)`
 * ownership: a connection belongs to its owner regardless of which org the
 * caller is currently scoped to (or whether they have an org context at all,
 * as with a cookie session). It carries the `applicationId` re-derived from the
 * resource row but deliberately NO `orgId`, so a consuming service can tell it
 * apart from an {@link AppScope} at the type level (`"orgId" in scope`) and skip
 * the app∈org escalation guard that only makes sense with an org. This replaces
 * the old `{ orgId: "" }` sentinel — the actor boundary is now expressed by the
 * absence of `orgId`, not a magic empty string.
 */
export interface ActorScope {
  readonly applicationId: string;
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
 * Read `orgId` + `applicationId` from the Hono context. Routes that call
 * this MUST be mounted behind `requireAppContext()` (or the path must
 * belong to `CORE_APP_SCOPED_PREFIXES` / a module's app-scoped paths) so
 * `applicationId` is pinned before this runs. Throwing indicates a
 * misconfigured route — not something the caller should handle.
 */
export function getAppScope(c: Context<AppEnv>): AppScope {
  const orgId = c.get("orgId");
  const applicationId = c.get("applicationId");
  if (!orgId || !applicationId) {
    throw internalError();
  }
  return { orgId, applicationId };
}
