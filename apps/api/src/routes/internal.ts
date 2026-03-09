import { Hono } from "hono";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { executions } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { getRecentExecutions, getAdminConnections } from "../services/state.ts";
import { getPackage } from "../services/flow-service.ts";
import { resolveCredentialsForProxy } from "@appstrate/connect";
import { getEffectiveProfileId } from "../services/connection-profiles.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";

/**
 * Verify the execution token from the Authorization header.
 * Returns the execution data or an HTTP error response.
 */
async function verifyExecutionToken(c: Context): Promise<
  | {
      ok: true;
      executionId: string;
      execution: {
        packageId: string;
        userId: string;
        orgId: string;
        status: string;
        connectionProfileId: string | null;
      };
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
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to fetch execution history" }, 500);
    }
  });

  // GET /internal/credentials/:scope/:name — called from inside containers
  // Auth: Bearer <executionId> (same mechanism as execution-history)
  // Returns unified format: { credentials: Record<string, string>, authorizedUris: string[] | null }
  router.get("/credentials/:scope{@[^/]+}/:name", async (c) => {
    const auth = await verifyExecutionToken(c);
    if (!auth.ok) return auth.response;

    const { executionId, execution } = auth;
    const serviceId = `${c.req.param("scope")}/${c.req.param("name")}`;

    // Load the flow to validate the requested service
    const flow = await getPackage(execution.packageId, execution.orgId);
    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: "Flow not found" }, 404);
    }

    const provider = resolveManifestProviders(flow.manifest).find((s) => s.id === serviceId);
    if (!provider) {
      logger.warn("Credential request for unknown provider", {
        executionId,
        providerId: serviceId,
        packageId: execution.packageId,
      });
      return c.json(
        {
          error: "PROVIDER_NOT_FOUND",
          message: `Provider '${serviceId}' is not required by this flow`,
        },
        404,
      );
    }

    try {
      // Resolve profile for this provider
      const connectionMode = provider.connectionMode ?? "user";
      let profileId: string;

      if (connectionMode === "admin") {
        const adminConns = await getAdminConnections(execution.orgId, execution.packageId);
        const adminProfileId = adminConns[serviceId];
        if (!adminProfileId) {
          return c.json(
            {
              error: "TOKEN_NOT_AVAILABLE",
              message: `No admin binding for service '${serviceId}'`,
            },
            404,
          );
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
        providerId: serviceId,
        provider: provider.provider,
        packageId: execution.packageId,
        connectionMode,
        profileId,
      });

      return c.json(result);
    } catch (err) {
      logger.error("Failed to resolve credentials", {
        executionId,
        providerId: serviceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "INTERNAL_ERROR", message: "Failed to resolve credentials" }, 500);
    }
  });

  return router;
}
