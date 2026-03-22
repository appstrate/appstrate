import { Hono } from "hono";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { executions } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { parseSignedToken } from "../lib/execution-token.ts";
import { rateLimitByBearer } from "../middleware/rate-limit.ts";
import { getRecentExecutions, getAdminConnections } from "../services/state/index.ts";
import { getPackage } from "../services/flow-service.ts";
import { resolveCredentialsForProxy } from "@appstrate/connect";
import { getEffectiveProfileId } from "../services/connection-profiles.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { unauthorized, forbidden, notFound, internalError } from "../lib/errors.ts";

/**
 * Verify the execution token from the Authorization header.
 * Returns the execution data or throws an ApiError.
 */
async function verifyExecutionToken(c: Context): Promise<{
  executionId: string;
  execution: {
    packageId: string;
    userId: string;
    orgId: string;
    status: string;
    connectionProfileId: string | null;
  };
}> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw unauthorized("Missing execution token");
  }

  const rawToken = authHeader.slice(7);
  if (!rawToken) {
    throw unauthorized("Invalid execution token");
  }

  // Verify HMAC signature before DB lookup
  const executionId = parseSignedToken(rawToken);
  if (!executionId) {
    throw unauthorized("Invalid execution token");
  }

  const rows = await db
    .select({
      packageId: executions.packageId,
      userId: executions.userId,
      orgId: executions.orgId,
      status: executions.status,
      connectionProfileId: executions.connectionProfileId,
    })
    .from(executions)
    .where(eq(executions.id, executionId))
    .limit(1);

  const execution = rows[0];
  if (!execution) {
    throw notFound("Execution not found");
  }

  if (execution.status !== "running") {
    throw forbidden("Execution is not running");
  }

  return {
    executionId,
    execution: {
      packageId: execution.packageId!,
      userId: execution.userId,
      orgId: execution.orgId,
      status: execution.status,
      connectionProfileId: execution.connectionProfileId,
    },
  };
}

export function createInternalRouter() {
  const router = new Hono();

  // Rate limit all internal endpoints (200 req/min per token)
  router.use("/*", rateLimitByBearer(200));

  // GET /internal/execution-history — called from inside containers
  // Auth: Bearer <signedToken> (HMAC-verified, then checked against executions table)
  router.get("/execution-history", async (c) => {
    const { executionId, execution } = await verifyExecutionToken(c);

    // Parse query parameters
    const limitParam = c.req.query("limit");
    const fieldsParam = c.req.query("fields");

    const limit = Math.max(1, Math.min(50, parseInt(limitParam || "10", 10) || 10));

    const validFields = ["state", "result"] as const;
    const parsed = fieldsParam
      ?.split(",")
      .map((f) => f.trim())
      .filter((f): f is "state" | "result" =>
        validFields.includes(f as (typeof validFields)[number]),
      );
    const fields: ("state" | "result")[] = parsed?.length ? parsed : ["state"];

    try {
      const recentExecutions = await getRecentExecutions(
        execution.packageId,
        execution.userId,
        execution.orgId,
        {
          limit,
          fields,
          excludeExecutionId: executionId,
        },
      );

      return c.json({ executions: recentExecutions });
    } catch (err) {
      logger.error("Failed to fetch execution history", {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError("Failed to fetch execution history");
    }
  });

  // GET /internal/credentials/:scope/:name — called from inside containers
  // Auth: Bearer <signedToken> (same HMAC mechanism as execution-history)
  // Returns unified format: { credentials: Record<string, string>, authorizedUris: string[] | null }
  router.get("/credentials/:scope{@[^/]+}/:name", async (c) => {
    const { executionId, execution } = await verifyExecutionToken(c);
    const providerId = `${c.req.param("scope")}/${c.req.param("name")}`;

    // Load the flow to validate the requested provider
    const flow = await getPackage(execution.packageId, execution.orgId);
    if (!flow) {
      throw notFound("Flow not found");
    }

    const provider = resolveManifestProviders(flow.manifest).find((s) => s.id === providerId);
    if (!provider) {
      logger.warn("Credential request for unknown provider", {
        executionId,
        providerId,
        packageId: execution.packageId,
      });
      throw notFound(`Provider '${providerId}' is not required by this flow`);
    }

    try {
      // Resolve profile for this provider
      const connectionMode = provider.connectionMode ?? "user";
      let profileId: string;

      if (connectionMode === "admin") {
        const adminConns = await getAdminConnections(execution.orgId, execution.packageId);
        const adminProfileId = adminConns[providerId];
        if (!adminProfileId) {
          throw notFound(`No admin binding for provider '${providerId}'`);
        }
        profileId = adminProfileId;
      } else {
        // Use the connection profile snapshot from the execution, or fall back to current
        profileId =
          execution.connectionProfileId ??
          (await getEffectiveProfileId(execution.userId, execution.packageId));
      }

      // Unified credential resolution
      const result = await resolveCredentialsForProxy(
        db,
        profileId,
        provider.provider,
        execution.orgId,
      );

      if (!result) {
        throw notFound(`No credentials for provider '${providerId}'`);
      }

      logger.info("Credential access", {
        executionId,
        providerId,
        provider: provider.provider,
        packageId: execution.packageId,
        connectionMode,
        profileId,
      });

      return c.json(result);
    } catch (err) {
      logger.error("Failed to resolve credentials", {
        executionId,
        providerId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError("Failed to resolve credentials");
    }
  });

  return router;
}
