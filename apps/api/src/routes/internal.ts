// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { Hono } from "hono";
import type { Context } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, userProviderConnections } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { parseSignedToken } from "../lib/run-token.ts";
import { rateLimitByBearer } from "../middleware/rate-limit.ts";
import { getRecentRuns } from "../services/state/index.ts";
import { getPackage } from "../services/agent-service.ts";
import {
  resolveCredentialsForProxy,
  forceRefreshCredentials,
  getProviderCredentialId,
} from "@appstrate/connect";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { unauthorized, forbidden, notFound, invalidRequest, internalError } from "../lib/errors.ts";
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
    applicationId: string;
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
      applicationId: runs.applicationId,
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
      applicationId: run.applicationId,
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
      const recentRuns = await getRecentRuns(run.packageId, actor, run.orgId, run.applicationId, {
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

    const credentialId = await getProviderCredentialId(db, run.applicationId, provider.id);
    if (!credentialId) {
      throw notFound(`No provider credentials configured for '${providerId}' in application`);
    }
    const result = await resolveCredentialsForProxy(
      db,
      profileId,
      provider.id,
      run.orgId,
      credentialId,
    );

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

  // POST /internal/credentials/:scope/:name/refresh — sidecar requests a forced token refresh on 401
  router.post("/credentials/:scope{@[^/]+}/:name/refresh", async (c) => {
    const { runId, run } = await verifyRunToken(c);
    const providerId = `${c.req.param("scope")}/${c.req.param("name")}`;

    const profileId = run.providerProfileIds?.[providerId];
    if (!profileId) {
      throw notFound(`No profile resolved for provider '${providerId}'`);
    }

    const credentialId = await getProviderCredentialId(db, run.applicationId, providerId);
    if (!credentialId) {
      throw notFound(`No provider credentials configured for '${providerId}' in application`);
    }
    try {
      const result = await forceRefreshCredentials(
        db,
        profileId,
        providerId,
        run.orgId,
        credentialId,
      );
      if (!result) {
        throw notFound(`No credentials for provider '${providerId}'`);
      }

      logger.info("Forced credential refresh", { runId, providerId, profileId });
      return c.json(result);
    } catch (err) {
      // Refresh failed (invalid_grant, network error) — flag the connection
      await db
        .update(userProviderConnections)
        .set({ needsReconnection: true, updatedAt: new Date() })
        .where(
          and(
            eq(userProviderConnections.profileId, profileId),
            eq(userProviderConnections.providerId, providerId),
            eq(userProviderConnections.orgId, run.orgId),
            eq(userProviderConnections.providerCredentialId, credentialId),
          ),
        );

      logger.warn("Forced refresh failed, connection flagged for reconnection", {
        runId,
        providerId,
        profileId,
        error: err instanceof Error ? err.message : String(err),
      });

      throw unauthorized(`Token refresh failed for provider '${providerId}'`);
    }
  });

  // POST /internal/connections/report-auth-failure — sidecar reports upstream 401
  router.post("/connections/report-auth-failure", async (c) => {
    const { runId, run } = await verifyRunToken(c);
    const body = await c.req.json();
    const parsed = z.object({ providerId: z.string().min(1) }).safeParse(body);
    if (!parsed.success) {
      throw invalidRequest("Missing or invalid providerId");
    }
    const { providerId } = parsed.data;

    const profileId = run.providerProfileIds?.[providerId];
    if (!profileId) {
      logger.warn("Auth failure report for unknown provider profile", { runId, providerId });
      return c.json({ flagged: false });
    }

    const credentialId = await getProviderCredentialId(db, run.applicationId, providerId);
    if (!credentialId) {
      logger.warn("No provider credential found for auth failure report", { runId, providerId });
      return c.json({ flagged: false });
    }

    await db
      .update(userProviderConnections)
      .set({ needsReconnection: true, updatedAt: new Date() })
      .where(
        and(
          eq(userProviderConnections.profileId, profileId),
          eq(userProviderConnections.providerId, providerId),
          eq(userProviderConnections.orgId, run.orgId),
          eq(userProviderConnections.providerCredentialId, credentialId),
        ),
      );

    logger.info("Connection flagged for reconnection after upstream 401", {
      runId,
      providerId,
      profileId,
    });

    return c.json({ flagged: true });
  });

  return router;
}
