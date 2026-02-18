import { Hono } from "hono";
import { supabase } from "../lib/supabase.ts";
import { logger } from "../lib/logger.ts";
import { getRecentExecutions } from "../services/state.ts";

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
      .select("flow_id, user_id, status")
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
      const executions = await getRecentExecutions(execution.flow_id, execution.user_id, {
        limit,
        fields,
        excludeExecutionId: executionId,
      });

      return c.json({ executions });
    } catch (err) {
      logger.error("Failed to fetch execution history", {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to fetch execution history" }, 500);
    }
  });

  return router;
}
