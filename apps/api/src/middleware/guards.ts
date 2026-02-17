import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";
import { isAdmin } from "../lib/supabase.ts";
import { getFlow } from "../services/flow-service.ts";
import { getRunningExecutionsForFlow } from "../services/state.ts";

/** Middleware: reject with 403 if the current user is not admin. */
export function requireAdmin() {
  return async (c: Context<AppEnv>, next: Next) => {
    const user = c.get("user");
    if (!(await isAdmin(user.id))) {
      return c.json({ error: "FORBIDDEN", message: "Acces reserve aux administrateurs" }, 403);
    }
    return next();
  };
}

/** Middleware: load a flow by route param and set it on context, or 404. */
export function requireFlow(paramName = "id") {
  return async (c: Context<AppEnv>, next: Next) => {
    const flowId = c.req.param(paramName);
    const flow = await getFlow(flowId);
    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: `Flow '${flowId}' introuvable` }, 404);
    }
    c.set("flow", flow);
    return next();
  };
}

/** Middleware: reject if flow is built-in (403) or has running executions (409). */
export function requireMutableFlow() {
  return async (c: Context<AppEnv>, next: Next) => {
    const flow = c.get("flow");
    if (flow.source !== "user") {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: "Impossible de modifier un flow built-in" },
        403,
      );
    }
    const running = await getRunningExecutionsForFlow(flow.id);
    if (running > 0) {
      return c.json(
        { error: "FLOW_IN_USE", message: `${running} execution(s) en cours pour ce flow` },
        409,
      );
    }
    return next();
  };
}
