// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { getPackage, getPackageWithAccess } from "../services/package-catalog.ts";
import { assertPackageMutationAccess } from "../lib/package-access.ts";
import { getRunningRunsForPackage } from "../services/state/runs.ts";
import { ApiError, forbidden, conflict, invalidRequest } from "../lib/errors.ts";

/** Middleware: load an agent by route param and set it on context, or 404.
 *  Also checks that the current space has access to the package. */
export function requireAgent() {
  return async (c: Context<AppEnv>, next: Next) => {
    const scope = c.req.param("scope");
    const name = c.req.param("name");
    const packageId = `${scope}/${name}`;
    const orgId = c.get("orgId");
    const spaceId = c.get("spaceId");

    const agent = await getPackageWithAccess(packageId, orgId, spaceId);
    if (!agent) {
      throw new ApiError({
        status: 404,
        code: "agent_not_found",
        title: "Agent Not Found",
        detail: `Agent '${packageId}' not found`,
      });
    }
    c.set("package", agent);
    return next();
  };
}

/** Middleware: load an agent by route param and set it on context, or 404.
 *  Checks org ownership only — does NOT check space-level access.
 *  Use for org-level operations (editing manifest, skills, tools). */
export function requireOrgAgent() {
  return async (c: Context<AppEnv>, next: Next) => {
    const scope = c.req.param("scope");
    const name = c.req.param("name");
    const packageId = `${scope}/${name}`;
    const orgId = c.get("orgId");

    const agent = await getPackage(packageId, orgId);
    if (!agent) {
      throw new ApiError({
        status: 404,
        code: "agent_not_found",
        title: "Agent Not Found",
        detail: `Agent '${packageId}' not found`,
      });
    }
    c.set("package", agent);
    return next();
  };
}

/** Extract the package ID from route params (scoped `@scope/name` or unscoped `id`). */
function extractPackageId(c: Context<AppEnv>): string {
  const scope = c.req.param("scope");
  const name = c.req.param("name");
  const id = c.req.param("id");
  // Route pattern `:scope{@[^/]+}` includes the @ prefix
  const packageId = scope && name ? `${scope}/${name}` : id;
  if (!packageId) {
    throw invalidRequest("Package ID is required");
  }
  return packageId;
}

/** Package ownership plus mutation authority in every affected installation space. */
export function requirePackageInOrg(action: "write" | "delete" = "write") {
  return async (c: Context<AppEnv>, next: Next) => {
    const packageId = extractPackageId(c);
    await assertPackageMutationAccess(c, packageId, action);
    return next();
  };
}

/** Middleware: for API key callers, reject with 403 when the `:orgId` route
 *  param does not match the key's bound org. Sessions are passed through
 *  unchanged — they legitimately see every org they belong to.
 *
 *  Why: issue #172. API keys carry an `orgId` scope but `/api/orgs/*`
 *  handlers historically resolved membership from the creator's `user.id`,
 *  letting a key issued in org A read/mutate other orgs the creator is a
 *  member of. Pin every `:orgId` route to the key's bound org. */
export async function apiKeyOrgScopeGuard(c: Context<AppEnv>, next: Next) {
  if (c.get("authMethod") !== "api_key") return next();
  const paramOrgId = c.req.param("orgId");
  if (paramOrgId && paramOrgId !== c.get("orgId")) {
    throw forbidden("API key scope does not include this organization");
  }
  return next();
}

/** Middleware: for API key callers, reject with 403 when the `:id`/`:spaceId`
 *  route param does not match the key's bound space. Sessions are
 *  passed through unchanged — any member can manage any space in their org.
 *
 *  Why: `/api/spaces` is org-scoped, not space-scoped, so the
 *  same orgId-only filtering pattern that lets a key escape its org also
 *  lets it escape its space within the same org. */
export async function apiKeySpaceScopeGuard(c: Context<AppEnv>, next: Next) {
  if (c.get("authMethod") !== "api_key") return next();
  const paramSpaceId = c.req.param("id") ?? c.req.param("spaceId");
  if (paramSpaceId && paramSpaceId !== c.get("spaceId")) {
    throw forbidden("API key scope does not include this space");
  }
  return next();
}

/** Middleware: reject if agent is system (403) or has running runs (409). */
export function requireMutableAgent() {
  return async (c: Context<AppEnv>, next: Next) => {
    const agent = c.get("package");
    if (agent.source === "system") {
      throw forbidden("Cannot modify a system agent");
    }
    const running = await getRunningRunsForPackage(
      { orgId: c.get("orgId"), spaceId: c.get("spaceId") },
      agent.id,
    );
    if (running > 0) {
      throw conflict("agent_in_use", `${running} run(s) running for this agent`);
    }
    return next();
  };
}
