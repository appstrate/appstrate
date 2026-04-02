// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { Hono } from "hono";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { parseSignedToken } from "../lib/run-token.ts";
import { rateLimitByBearer } from "../middleware/rate-limit.ts";
import { getRecentRuns } from "../services/state/index.ts";
import { getPackage } from "../services/agent-service.ts";
import { resolveCredentialsForProxy } from "@appstrate/connect";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { unauthorized, forbidden, notFound, internalError } from "../lib/errors.ts";
import { actorFromIds, type Actor } from "../lib/actor.ts";

/**
 * Verify the run token from the Authorization header.
 * Returns the run data or throws an ApiError.
 */
async function verifyRunToken(c: Context): Promise<{
  runId: string;
  run: {
    packageId: string;
    userId: string | null;
    endUserId: string | null;
    orgId: string;
    status: string;
    connectionProfileId: string | null;
    providerProfileIds: Record<string, string> | null;
  };
}> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw unauthorized("Missing run token");
  }

  const rawToken = authHeader.slice(7);
  if (!rawToken) {
    throw unauthorized("Invalid run token");
  }

  // Verify HMAC signature before DB lookup
  const runId = parseSignedToken(rawToken);
  if (!runId) {
    throw unauthorized("Invalid run token");
  }

  const rows = await db
    .select({
      packageId: runs.packageId,
      userId: runs.userId,
      endUserId: runs.endUserId,
      orgId: runs.orgId,
      status: runs.status,
      connectionProfileId: runs.connectionProfileId,
      providerProfileIds: runs.providerProfileIds,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  const run = rows[0];
  if (!run) {
    throw notFound("Run not found");
  }

  if (run.status !== "running") {
    throw forbidden("Run is not running");
  }

  return {
    runId,
    run: {
      packageId: run.packageId!,
      userId: run.userId,
      endUserId: run.endUserId,
      orgId: run.orgId,
      status: run.status,
      connectionProfileId: run.connectionProfileId,
      providerProfileIds: run.providerProfileIds ?? null,
    },
  };
}

export function createInternalRouter() {
  const router = new Hono();

  // Rate limit all internal endpoints (200 req/min per token)
  router.use("/*", rateLimitByBearer(200));

  // GET /internal/run-history — called from inside containers
  // Auth: Bearer <signedToken> (HMAC-verified, then checked against runs table)
  router.get("/run-history", async (c) => {
    const { runId, run } = await verifyRunToken(c);

    // Parse query parameters
    const limitParam = c.req.query("limit");
    const fieldsParam = c.req.query("fields");

    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .catch(10)
      .parse(limitParam ?? 10);

    const validFields = ["state", "result"] as const;
    const parsed = fieldsParam
      ?.split(",")
      .map((f) => f.trim())
      .filter((f): f is "state" | "result" =>
        validFields.includes(f as (typeof validFields)[number]),
      );
    const fields: ("state" | "result")[] = parsed?.length ? parsed : ["state"];

    try {
      const actor: Actor | null = actorFromIds(run.userId, run.endUserId);
      const recentRuns = await getRecentRuns(run.packageId, actor, run.orgId, {
        limit,
        fields,
        excludeRunId: runId,
      });

      return c.json({ runs: recentRuns });
    } catch (err) {
      logger.error("Failed to fetch run history", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  // GET /internal/credentials/:scope/:name — called from inside containers
  // Auth: Bearer <signedToken> (same HMAC mechanism as run-history)
  // Returns unified format: { credentials: Record<string, string>, authorizedUris: string[] | null }
  router.get("/credentials/:scope{@[^/]+}/:name", async (c) => {
    const { runId, run } = await verifyRunToken(c);
    const providerId = `${c.req.param("scope")}/${c.req.param("name")}`;

    // Load the agent to validate the requested provider
    const agent = await getPackage(run.packageId, run.orgId);
    if (!agent) {
      throw notFound("Agent not found");
    }

    const provider = resolveManifestProviders(agent.manifest).find((s) => s.id === providerId);
    if (!provider) {
      logger.warn("Credential request for unknown provider", {
        runId,
        providerId,
        packageId: run.packageId,
      });
      throw notFound(`Provider '${providerId}' is not required by this agent`);
    }

    // Look up the stored profileId from the run record
    const profileId = run.providerProfileIds?.[providerId];
    if (!profileId) {
      throw notFound(`No profile resolved for provider '${providerId}'`);
    }

    const result = await resolveCredentialsForProxy(db, profileId, provider.id, run.orgId);

    if (!result) {
      throw notFound(`No credentials for provider '${providerId}'`);
    }

    logger.info("Credential access", {
      runId,
      providerId,
      packageId: run.packageId,
      profileId,
    });

    return c.json(result);
  });

  return router;
}
