import { Hono } from "hono";
import { supabase } from "../lib/supabase.ts";
import { logger } from "../lib/logger.ts";
import {
  getRecentExecutions,
  getAdminConnections,
  getCustomCredentials,
} from "../services/state.ts";
import { getFlow } from "../services/flow-service.ts";
import { getAccessToken } from "../services/nango.ts";
import {
  getDefaultAuthorizedUris,
  getNangoCredentialField,
} from "../services/adapters/provider-urls.ts";

export function createInternalRouter() {
  const router = new Hono();

  // GET /internal/execution-history — called from inside containers
  // Auth: Bearer <executionId> (verified against executions table, must be running)
  router.get("/execution-history", async (c) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "UNAUTHORIZED", message: "Missing execution token" }, 401);
    }

    const executionId = authHeader.slice(7);
    if (!executionId) {
      return c.json({ error: "UNAUTHORIZED", message: "Invalid execution token" }, 401);
    }

    // Look up the execution — must exist and be running
    const { data: execution, error } = await supabase
      .from("executions")
      .select("flow_id, user_id, org_id, status")
      .eq("id", executionId)
      .single();

    if (error || !execution) {
      return c.json({ error: "UNAUTHORIZED", message: "Execution not found" }, 401);
    }

    if (execution.status !== "running") {
      return c.json({ error: "UNAUTHORIZED", message: "Execution is not running" }, 401);
    }

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
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "UNAUTHORIZED", message: "Missing execution token" }, 401);
    }

    const executionId = authHeader.slice(7);
    if (!executionId) {
      return c.json({ error: "UNAUTHORIZED", message: "Invalid execution token" }, 401);
    }

    const serviceId = c.req.param("serviceId");

    // Look up the execution — must exist and be running
    const { data: execution, error } = await supabase
      .from("executions")
      .select("flow_id, user_id, org_id, status")
      .eq("id", executionId)
      .single();

    if (error || !execution) {
      return c.json({ error: "UNAUTHORIZED", message: "Execution not found" }, 401);
    }

    if (execution.status !== "running") {
      return c.json({ error: "UNAUTHORIZED", message: "Execution is not running" }, 401);
    }

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

      // Custom service — return credentials from DB
      if (service.provider === "custom") {
        const creds = await getCustomCredentials(
          tokenOrgId,
          tokenUserId,
          execution.flow_id,
          serviceId,
        );
        if (!creds) {
          return c.json(
            {
              error: "TOKEN_NOT_AVAILABLE",
              message: `No credentials for custom service '${serviceId}'`,
            },
            404,
          );
        }

        logger.info("Credential access (custom)", {
          executionId,
          serviceId,
          flowId: execution.flow_id,
          connectionMode,
        });

        return c.json({
          credentials: creds,
          authorizedUris: service.authorized_uris ?? null,
          allowAllUris: service.allow_all_uris ?? false,
        });
      }

      // Nango service — return token wrapped in unified format
      const token = await getAccessToken(service.provider, tokenOrgId, tokenUserId);
      if (!token) {
        return c.json(
          {
            error: "TOKEN_NOT_AVAILABLE",
            message: `No active connection for service '${serviceId}'`,
          },
          404,
        );
      }

      const { name: fieldName } = getNangoCredentialField(serviceId);
      const authorizedUris =
        service.authorized_uris ?? getDefaultAuthorizedUris(serviceId, service.provider);

      logger.info("Credential access", {
        executionId,
        serviceId,
        provider: service.provider,
        flowId: execution.flow_id,
        connectionMode,
      });

      return c.json({
        credentials: { [fieldName]: token },
        authorizedUris,
        allowAllUris: service.allow_all_uris ?? false,
      });
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
