import { Hono } from "hono";
import type { Context } from "hono";
import { supabase } from "../lib/supabase.ts";
import { logger } from "../lib/logger.ts";
import { getRecentExecutions, getAdminConnections } from "../services/state.ts";
import { getFlow } from "../services/flow-service.ts";
import { resolveCredentialsForProxy } from "@appstrate/connect";

/**
 * Verify the execution token from the Authorization header.
 * Returns the execution data or an HTTP error response.
 */
async function verifyExecutionToken(c: Context): Promise<
  | {
      ok: true;
      executionId: string;
      execution: { flow_id: string; user_id: string; org_id: string; status: string };
    }
  | { ok: false; response: Response }
> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      ok: false,
      response: c.json({ error: "UNAUTHORIZED", message: "Missing execution token" }, 401),
    };
  }

  const executionId = authHeader.slice(7);
  if (!executionId) {
    return {
      ok: false,
      response: c.json({ error: "UNAUTHORIZED", message: "Invalid execution token" }, 401),
    };
  }

  const { data: execution, error } = await supabase
    .from("executions")
    .select("flow_id, user_id, org_id, status")
    .eq("id", executionId)
    .single();

  if (error || !execution) {
    return {
      ok: false,
      response: c.json({ error: "NOT_FOUND", message: "Execution not found" }, 404),
    };
  }

  if (execution.status !== "running") {
    return {
      ok: false,
      response: c.json({ error: "FORBIDDEN", message: "Execution is not running" }, 403),
    };
  }

  return {
    ok: true,
    executionId,
    execution: execution as { flow_id: string; user_id: string; org_id: string; status: string },
  };
}

export function createInternalRouter() {
  const router = new Hono();

  // GET /internal/execution-history — called from inside containers
  // Auth: Bearer <executionId> (verified against executions table, must be running)
  router.get("/execution-history", async (c) => {
    const auth = await verifyExecutionToken(c);
    if (!auth.ok) return auth.response;

    const { executionId, execution } = auth;

    // Parse query parameters
    const limitParam = c.req.query("limit");
    const fieldsParam = c.req.query("fields");

    const limit = Math.max(1, Math.min(50, parseInt(limitParam || "10", 10) || 10));

    const validFields = new Set(["state", "result"]);
    const fields = fieldsParam
      ? (fieldsParam
          .split(",")
          .map((f) => f.trim())
          .filter((f) => validFields.has(f)) as ("state" | "result")[])
      : ["state" as const];

    if (fields.length === 0) {
      fields.push("state");
    }

    try {
      const executions = await getRecentExecutions(
        execution.flow_id,
        execution.user_id,
        execution.org_id,
        {
          limit,
          fields,
          excludeExecutionId: executionId,
        },
      );

      return c.json({ executions });
    } catch (err) {
      logger.error("Failed to fetch execution history", {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to fetch execution history" }, 500);
    }
  });

  // GET /internal/credentials/:serviceId — called from inside containers
  // Auth: Bearer <executionId> (same mechanism as execution-history)
  // Returns unified format: { credentials: Record<string, string>, authorizedUris: string[] | null }
  router.get("/credentials/:serviceId", async (c) => {
    const auth = await verifyExecutionToken(c);
    if (!auth.ok) return auth.response;

    const { executionId, execution } = auth;
    const serviceId = c.req.param("serviceId");

    // Load the flow to validate the requested service
    const flow = await getFlow(execution.flow_id, execution.org_id);
    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: "Flow not found" }, 404);
    }

    const service = flow.manifest.requires.services.find((s) => s.id === serviceId);
    if (!service) {
      logger.warn("Credential request for unknown service", {
        executionId,
        serviceId,
        flowId: execution.flow_id,
      });
      return c.json(
        {
          error: "SERVICE_NOT_FOUND",
          message: `Service '${serviceId}' is not required by this flow`,
        },
        404,
      );
    }

    try {
      // Resolve connection mode: admin connections override user connections
      const connectionMode = service.connectionMode ?? "user";
      const tokenOrgId = execution.org_id;
      let tokenUserId = execution.user_id;

      if (connectionMode === "admin") {
        const adminConns = await getAdminConnections(execution.org_id, execution.flow_id);
        const adminUserId = adminConns[serviceId];
        if (adminUserId) {
          tokenUserId = adminUserId;
        }
      }

      // Unified credential resolution — all services resolve via provider
      const result = await resolveCredentialsForProxy(
        supabase,
        tokenOrgId,
        tokenUserId,
        service.provider,
      );

      if (!result) {
        return c.json(
          {
            error: "TOKEN_NOT_AVAILABLE",
            message: `No credentials for service '${serviceId}'`,
          },
          404,
        );
      }

      logger.info("Credential access", {
        executionId,
        serviceId,
        provider: service.provider,
        flowId: execution.flow_id,
        connectionMode,
      });

      return c.json(result);
    } catch (err) {
      logger.error("Failed to resolve credentials", {
        executionId,
        serviceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to resolve credentials" }, 500);
    }
  });

  return router;
}
