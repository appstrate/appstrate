import { Hono } from "hono";
import { supabase } from "../lib/supabase.ts";
import { getBuiltInFlowCount } from "../services/flow-service.ts";

const startedAt = Date.now();

const healthRouter = new Hono();

healthRouter.get("/health", async (c) => {
  const checks: Record<string, { status: string; latency_ms?: number }> = {};

  // Database check
  const dbStart = Date.now();
  try {
    const { error } = await supabase.from("profiles").select("id", { count: "exact", head: true });
    checks.database = {
      status: error ? "unhealthy" : "healthy",
      latency_ms: Date.now() - dbStart,
    };
  } catch {
    checks.database = { status: "unhealthy", latency_ms: Date.now() - dbStart };
  }

  // Flows check
  checks.flows = {
    status: getBuiltInFlowCount() > 0 ? "healthy" : "degraded",
  };

  const allHealthy = Object.values(checks).every((c) => c.status === "healthy");
  const status = allHealthy ? "healthy" : "degraded";
  const httpStatus = status === "healthy" ? 200 : 503;

  return c.json(
    {
      status,
      uptime_ms: Date.now() - startedAt,
      checks,
    },
    httpStatus,
  );
});

export default healthRouter;
