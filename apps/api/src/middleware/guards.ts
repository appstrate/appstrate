import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { isOwnedByOrg } from "@appstrate/core/naming";
import { getPackage } from "../services/flow-service.ts";
import { getRunningExecutionsForPackage } from "../services/state.ts";

/** Middleware: reject with 403 if the current user is not org admin/owner. */
export function requireAdmin() {
  return async (c: Context<AppEnv>, next: Next) => {
    const orgRole = c.get("orgRole");
    if (orgRole !== "admin" && orgRole !== "owner") {
      return c.json({ error: "FORBIDDEN", message: "Admin access required" }, 403);
    }
    return next();
  };
}

/** Middleware: load a flow by route param and set it on context, or 404. */
export function requireFlow() {
  return async (c: Context<AppEnv>, next: Next) => {
    const scope = c.req.param("scope");
    const name = c.req.param("name");
    const packageId = `${scope}/${name}`;
    const orgId = c.get("orgId");
    const flow = await getPackage(packageId, orgId);
    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: `Flow '${packageId}' not found` }, 404);
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
    if (!packageId) return next();

    const orgSlug = c.get("orgSlug");
    if (!isOwnedByOrg(packageId, orgSlug)) {
      return c.json(
        {
          error: "NOT_OWNED",
          message: "Cannot modify a package not owned by your organization. Fork it instead.",
        },
        403,
      );
    }
    return next();
  };
}

/** Middleware: reject if flow is system (403) or has running executions (409). */
export function requireMutableFlow() {
  return async (c: Context<AppEnv>, next: Next) => {
    const flow = c.get("flow");
    if (flow.source === "system") {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: "Cannot modify a system flow" },
        403,
      );
    }
    const running = await getRunningExecutionsForPackage(flow.id);
    if (running > 0) {
      return c.json(
        { error: "FLOW_IN_USE", message: `${running} execution(s) running for this flow` },
        409,
      );
    }
    return next();
  };
}
