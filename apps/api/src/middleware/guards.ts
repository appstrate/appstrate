// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { isOwnedByOrg } from "@appstrate/core/naming";
import { getPackage } from "../services/flow-service.ts";
import { getRunningExecutionsForPackage } from "../services/state/index.ts";
import { ApiError, forbidden, conflict, invalidRequest } from "../lib/errors.ts";

/** Middleware: load a flow by route param and set it on context, or 404. */
export function requireFlow() {
  return async (c: Context<AppEnv>, next: Next) => {
    const scope = c.req.param("scope");
    const name = c.req.param("name");
    const packageId = `${scope}/${name}`;
    const orgId = c.get("orgId");
    const flow = await getPackage(packageId, orgId);
    if (!flow) {
      throw new ApiError({
        status: 404,
        code: "flow_not_found",
        title: "Flow Not Found",
        detail: `Flow '${packageId}' not found`,
      });
    }
    c.set("flow", flow);
    return next();
  };
}

/** Middleware: reject with 403 if the package is not owned by the current org. */
export function requireOwnedPackage() {
  return async (c: Context<AppEnv>, next: Next) => {
    const scope = c.req.param("scope");
    const name = c.req.param("name");
    const id = c.req.param("id");
    // Route pattern `:scope{@[^/]+}` includes the @ prefix
    const packageId = scope && name ? `${scope}/${name}` : id;
    if (!packageId) {
      throw invalidRequest("Package ID is required");
    }

    const orgSlug = c.get("orgSlug");
    if (!isOwnedByOrg(packageId, orgSlug)) {
      throw forbidden("Cannot modify a package not owned by your organization. Fork it instead.");
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

/** Middleware: reject if flow is system (403) or has running executions (409). */
export function requireMutableFlow() {
  return async (c: Context<AppEnv>, next: Next) => {
    const flow = c.get("flow");
    if (flow.source === "system") {
      throw forbidden("Cannot modify a system flow");
    }
    const running = await getRunningExecutionsForPackage(flow.id);
    if (running > 0) {
      throw conflict("flow_in_use", `${running} execution(s) running for this flow`);
    }
    return next();
  };
}
