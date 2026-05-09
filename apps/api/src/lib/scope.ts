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
