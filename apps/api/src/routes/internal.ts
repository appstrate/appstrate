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
import {
  getRecentRuns,
  RUN_HISTORY_FIELDS,
  type RunHistoryField,
} from "../services/state/index.ts";
import {
  recallMemories,
  RECALL_LIMIT_DEFAULT,
  RECALL_LIMIT_MAX,
  scopeFromActor,
  MAX_MEMORY_CONTENT,
} from "../services/state/package-persistence.ts";
import { getPackage } from "../services/agent-service.ts";
import {
  resolveCredentialsForProxy,
  forceRefreshCredentials,
  getProviderCredentialId,
  getConnection,
  RefreshError,
} from "@appstrate/connect";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { unauthorized, forbidden, notFound, invalidRequest, internalError } from "../lib/errors.ts";
import { actorFromIds, type Actor } from "../lib/actor.ts";

export const reportAuthFailureSchema = z.object({ providerId: z.string().min(1) });

/**
 * Safety margin used when deciding whether a stored access token is still
 * "fresh enough" that a forced refresh would be wasteful. The sidecar calls
 * the refresh endpoint on any upstream 401; if the stored token has more
 * than this much lifetime remaining, the 401 cannot be an expiry issue and
 * must come from the agent's request itself (wrong header, wrong endpoint,
 * missing scope) — so we skip the refresh entirely. Keeping a full minute
 * absorbs reasonable clock skew between this server and the OAuth provider.
 */
const REFRESH_FRESHNESS_THRESHOLD_MS = 60_000;

/**
 * Returns true when the stored access token still has enough lifetime left
 * that refreshing it would be pointless. Null / missing / unparseable
 * `expiresAt` (providers without `expires_in`, legacy connections, non-OAuth2
 * auth modes) returns false — we fall back to the existing refresh behavior
 * in that case.
 */
export function isTokenFresh(expiresAt: string | Date | null | undefined): boolean {
  if (!expiresAt) return false;
  const ts = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  if (Number.isNaN(ts)) return false;
  return ts - Date.now() > REFRESH_FRESHNESS_THRESHOLD_MS;
}

/**
 * Verify the run token from the Authorization header.
 * Returns the run data or throws an ApiError.
 */
async function verifyRunToken(c: Context): Promise<{
  runId: string;
  run: {
    packageId: string;
    dashboardUserId: string | null;
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
      dashboardUserId: runs.dashboardUserId,
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
      dashboardUserId: run.dashboardUserId,
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

    // Wire field names — `state` (AFPS ≤ 1.3) is no longer accepted.
    // The floor of supported runners is now AFPS 1.4 (ADR-011 final cut).
    // Unknown values fail loudly with 400 so a stale runner schema can't
    // silently strip fields the agent is asking for.
    let fields: RunHistoryField[] = ["checkpoint"];
    if (fieldsParam !== undefined) {
      const requested = fieldsParam
        .split(",")
        .map((f) => f.trim())
        .filter((f) => f.length > 0);
      const invalid = requested.filter((f) => !RUN_HISTORY_FIELDS.includes(f as RunHistoryField));
      if (invalid.length > 0) {
        throw invalidRequest(
          `Unknown fields: ${invalid.join(", ")}. Valid: ${RUN_HISTORY_FIELDS.join(", ")}.`,
          "fields",
        );
      }
      const dedup = [...new Set(requested as RunHistoryField[])];
      if (dedup.length > 0) fields = dedup;
    }

    try {
      // Actor isolation is mandatory: `getRecentRuns` filters runs by
      // dashboardUserId / endUserId so an end-user run never sees
      // another actor's checkpoint, and a scheduled run (actor === null)
      // sees only the shared / no-actor bucket.
      const actor: Actor | null = actorFromIds(run.dashboardUserId, run.endUserId);
      const recentRuns = await getRecentRuns(
        { orgId: run.orgId, applicationId: run.applicationId },
        run.packageId,
        actor,
        {
          limit,
          fields,
          excludeRunId: runId,
        },
      );

      return c.json({ object: "list" as const, data: recentRuns, hasMore: false });
    } catch (err) {
      logger.error("Failed to fetch run history", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw internalError();
    }
  });

  // GET /internal/memories — backs the agent-facing `recall_memory` MCP
  // tool. Returns archive (pinned=false) memories visible to the run's
  // actor, optionally filtered by an ILIKE substring match. Pinned
  // memories are NOT returned here — they're already in the system prompt.
  router.get("/memories", async (c) => {
    const { runId, run } = await verifyRunToken(c);

    const queryRaw = c.req.query("q");
    const query = queryRaw && queryRaw.trim().length > 0 ? queryRaw.trim() : undefined;
    if (query !== undefined && query.length > MAX_MEMORY_CONTENT) {
      throw invalidRequest(`Query too long (max ${MAX_MEMORY_CONTENT} chars).`, "q");
    }

    const limitParam = c.req.query("limit");
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(RECALL_LIMIT_MAX)
      .catch(RECALL_LIMIT_DEFAULT)
      .parse(limitParam ?? RECALL_LIMIT_DEFAULT);

    try {
      const actor: Actor | null = actorFromIds(run.dashboardUserId, run.endUserId);
      const memories = await recallMemories(
        run.packageId,
        run.applicationId,
        scopeFromActor(actor),
        { ...(query !== undefined ? { query } : {}), limit },
      );

      return c.json({
        memories: memories.map((m) => ({
          id: m.id,
          content: m.content,
          createdAt: m.createdAt.toISOString(),
          actorType: m.actorType,
          actorId: m.actorId,
        })),
      });
    } catch (err) {
      logger.error("Failed to recall memories", {
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

    // Load the agent to validate the requested provider. Inline runs use
    // an ephemeral shadow package — `includeEphemeral` keeps the lookup
    // working for `POST /api/runs/inline` flows without changing the
    // strict default that public package listings exclude shadows.
    const agent = await getPackage(run.packageId, run.orgId, { includeEphemeral: true });
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

    // Skip the OAuth refresh round-trip if the stored token still has
    // significant lifetime left. A 401 on a demonstrably-fresh token cannot
    // be an expiry issue — it must come from the agent's request itself
    // (wrong header, wrong endpoint, missing scope). Refreshing here would
    // burn provider rate limits, add latency, and churn rotating
    // refresh_tokens for no benefit.
    const connection = await getConnection(db, profileId, providerId, run.orgId, credentialId);
    if (connection && isTokenFresh(connection.expiresAt)) {
      const passthrough = await resolveCredentialsForProxy(
        db,
        profileId,
        providerId,
        run.orgId,
        credentialId,
      );
      if (!passthrough) {
        throw notFound(`No credentials for provider '${providerId}'`);
      }

      logger.info("Skipping refresh — stored token still fresh", {
        runId,
        providerId,
        profileId,
        expiresInMs: Date.parse(connection.expiresAt!) - Date.now(),
      });

      return c.json(passthrough);
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
      // Only a definitive "refresh_token is dead" signal (RFC 6749 §5.2:
      // HTTP 400 + body.error === "invalid_grant") justifies flagging the
      // connection. Transient failures (network, 5xx, timeout, non-JSON,
      // other OAuth error codes) must not flag — the credential might still
      // be valid and the initial 401 that triggered this refresh may have
      // come from a malformed agent request, not a dead token.
      if (err instanceof RefreshError && err.kind === "revoked") {
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

        logger.warn("Refresh token revoked, connection flagged for reconnection", {
          runId,
          providerId,
          profileId,
          status: err.status,
        });

        throw unauthorized(`Token refresh failed for provider '${providerId}': credential revoked`);
      }

      logger.warn("Transient refresh failure, connection left unchanged", {
        runId,
        providerId,
        profileId,
        kind: err instanceof RefreshError ? err.kind : "unknown",
        status: err instanceof RefreshError ? err.status : undefined,
        error: err instanceof Error ? err.message : String(err),
      });

      throw unauthorized(`Token refresh failed for provider '${providerId}' (transient)`);
    }
  });

  // POST /internal/connections/report-auth-failure — sidecar reports upstream 401
  //
  // A single 401 on an agent-generated request is NOT reliable evidence that
  // the stored credential is dead. LLM agents frequently produce malformed
  // requests (wrong header name, wrong auth scheme, wrong endpoint, missing
  // API version header, wrong HTTP method) that providers reject with 401
  // even when the token is perfectly valid. Flagging the connection on that
  // basis forces users to reconnect unnecessarily and blocks all subsequent
  // runs via dependency-validation.
  //
  // The only reliable "credential is dead" signal is a failed token refresh
  // with HTTP 400 + body.error === "invalid_grant" (RFC 6749 §5.2), handled
  // in the /credentials/:scope/:name/refresh route above.
  //
  // This endpoint is kept for telemetry — the sidecar still reports the
  // failure so we can surface patterns in logs (provider returning 401
  // frequently, specific agent generating malformed requests) — but it
  // never mutates the connection.
  router.post("/connections/report-auth-failure", async (c) => {
    const { runId, run } = await verifyRunToken(c);
    const body = await c.req.json();
    const parsed = reportAuthFailureSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidRequest("Missing or invalid providerId");
    }
    const { providerId } = parsed.data;
    const profileId = run.providerProfileIds?.[providerId];

    logger.info("Upstream 401 reported by sidecar (connection not flagged)", {
      runId,
      providerId,
      profileId: profileId ?? null,
      reason: "single-request 401 is ambiguous (agent syntax error vs dead credential)",
    });

    return c.json({ flagged: false });
  });

  return router;
}
