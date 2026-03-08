import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { getSystemPackagesByType } from "../services/system-packages.ts";

const startedAt = Date.now();

const healthRouter = new Hono();

healthRouter.get("/health", async (c) => {
  const checks: Record<string, { status: string; latency_ms?: number }> = {};

  // Database check
  const dbStart = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    checks.database = {
      status: "healthy",
      latency_ms: Date.now() - dbStart,
    };
  } catch {
    checks.database = { status: "unhealthy", latency_ms: Date.now() - dbStart };
  }

  // System packages check
  const systemFlowCount = getSystemPackagesByType("flow").length;
  checks.flows = {
    status: systemFlowCount > 0 ? "healthy" : "degraded",
  };

  const hasUnhealthy = Object.values(checks).some((c) => c.status === "unhealthy");
  const allHealthy = Object.values(checks).every((c) => c.status === "healthy");
  const status = hasUnhealthy ? "unhealthy" : allHealthy ? "healthy" : "degraded";
  const httpStatus = hasUnhealthy ? 503 : 200;

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
