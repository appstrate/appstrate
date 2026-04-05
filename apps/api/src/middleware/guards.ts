// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { isOwnedByOrg } from "@appstrate/core/naming";
import { getPackage, getPackageWithAccess } from "../services/agent-service.ts";
import { getPackageById } from "../services/package-items/crud.ts";
import { getRunningRunsForPackage } from "../services/state/index.ts";
import { ApiError, forbidden, notFound, conflict, invalidRequest } from "../lib/errors.ts";

/** Middleware: load an agent by route param and set it on context, or 404.
 *  Also checks that the current application has access to the package. */
export function requireAgent() {
  return async (c: Context<AppEnv>, next: Next) => {
    const scope = c.req.param("scope");
    const name = c.req.param("name");
    const packageId = `${scope}/${name}`;
    const orgId = c.get("orgId");
    const appId = c.get("applicationId");

    const agent = await getPackageWithAccess(packageId, orgId, appId);
    if (!agent) {
      throw new ApiError({
        status: 404,
        code: "agent_not_found",
        title: "Agent Not Found",
        detail: `Agent '${packageId}' not found`,
      });
    }
    c.set("agent", agent);
    return next();
  };
}

/** Middleware: load an agent by route param and set it on context, or 404.
 *  Checks org ownership only — does NOT check app-level access.
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
    c.set("agent", agent);
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

/** Middleware: reject with 403 if the package scope doesn't match the org slug.
 *  Use for content mutation (edit, publish versions) where scope identity matters. */
export function requireOwnedPackage() {
  return async (c: Context<AppEnv>, next: Next) => {
    const packageId = extractPackageId(c);
    const orgSlug = c.get("orgSlug");
    if (!isOwnedByOrg(packageId, orgSlug)) {
      throw forbidden("Cannot modify a package not owned by your organization. Fork it instead.");
    }
    return next();
  };
}

/** Middleware: reject with 404/403 if the package doesn't belong to the current org in the DB.
 *  Use for lifecycle operations (delete) where DB ownership matters, not scope. */
export function requireOrgPackage() {
  return async (c: Context<AppEnv>, next: Next) => {
    const packageId = extractPackageId(c);
    const orgId = c.get("orgId");
    const row = await getPackageById(packageId);
    if (!row) {
      throw notFound(`Package '${packageId}' not found`);
    }
    if (row.orgId !== orgId) {
      throw forbidden("Cannot delete a package not in your organization.");
    }
    return next();
  };
}

/** Check that a packageId scope matches the current org. Returns an ApiError or null. */
export function checkScopeMatch(c: Context<AppEnv>, packageId: string): ApiError | null {
  const orgSlug = c.get("orgSlug");
  if (!isOwnedByOrg(packageId, orgSlug)) {
    return new ApiError({
      status: 403,
      code: "scope_mismatch",
      title: "Scope Mismatch",
      detail: `Package scope must match your organization (@${orgSlug})`,
    });
  }
  return null;
}

/** Middleware: reject if agent is system (403) or has running runs (409). */
export function requireMutableAgent() {
  return async (c: Context<AppEnv>, next: Next) => {
    const agent = c.get("agent");
    if (agent.source === "system") {
      throw forbidden("Cannot modify a system agent");
    }
    const running = await getRunningRunsForPackage(agent.id, c.get("orgId"));
    if (running > 0) {
      throw conflict("agent_in_use", `${running} run(s) running for this agent`);
    }
    return next();
  };
}
