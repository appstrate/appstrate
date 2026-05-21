// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { Hono } from "hono";
import type { Context } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  applicationPackages,
  modelProviderCredentials,
  packageVersions,
  runs,
} from "@appstrate/db/schema";
import { sql } from "drizzle-orm";
import { asRecord } from "@appstrate/core/safe-json";
import { downloadVersionZip } from "../services/package-storage.ts";
import { getSystemPackages } from "../services/system-packages.ts";
import { logger } from "../lib/logger.ts";
import { listResponse } from "../lib/list-response.ts";
import { parseSignedToken } from "../lib/run-token.ts";
import { rateLimitByBearer } from "../middleware/rate-limit.ts";
import { getRecentRuns, RUN_HISTORY_FIELDS, type RunHistoryField } from "../services/state/runs.ts";
import {
  recallMemories,
  RECALL_LIMIT_DEFAULT,
  RECALL_LIMIT_MAX,
  scopeFromActor,
  MAX_MEMORY_CONTENT,
} from "../services/state/package-persistence.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { getPackage } from "../services/package-catalog.ts";
import { unauthorized, forbidden, notFound, invalidRequest, internalError } from "../lib/errors.ts";
import { actorFromIds, type Actor } from "../lib/actor.ts";
import {
  forceRefreshOAuthModelProviderToken,
  resolveOAuthTokenForSidecar,
} from "../services/model-providers/token-resolver.ts";
import { resolveLiveIntegrationCredentials } from "../services/integration-credentials-resolver.ts";

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
    userId: string | null;
    endUserId: string | null;
    orgId: string;
    applicationId: string;
    status: string;
    modelCredentialId: string | null;
    runOrigin: "platform" | "remote";
    /**
     * Snapshot of the connection resolver output frozen at run kickoff
     * (#199). The credentials resolver uses it to honour admin pins and
     * per-run overrides past the kickoff handoff.
     */
    resolvedConnections: Record<string, { connectionId: string; source: string }> | null;
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
      modelCredentialId: runs.modelCredentialId,
      runOrigin: runs.runOrigin,
      resolvedConnections: runs.resolvedConnections,
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
      modelCredentialId: run.modelCredentialId ?? null,
      runOrigin: run.runOrigin,
      resolvedConnections: run.resolvedConnections ?? null,
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
      // userId / endUserId so an end-user run never sees another actor's
      // checkpoint, and a scheduled run (actor === null) sees only the
      // shared / no-actor bucket.
      const actor: Actor | null = actorFromIds(run.userId, run.endUserId);
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

      return c.json(listResponse(recentRuns));
    } catch (err) {
      logger.error("Failed to fetch run history", {
        runId,
        error: getErrorMessage(err),
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
      const actor: Actor | null = actorFromIds(run.userId, run.endUserId);
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
        error: getErrorMessage(err),
      });
      throw internalError();
    }
  });

  // ─── OAuth Model Provider tokens ──────────────────────────────────────
  //
  // Sidecar polls these endpoints during /llm/* request lifecycle (cf.
  // SPEC §5.2). Auth is the same Bearer run-token mechanism as the rest
  // of /internal/* — `assertOAuthModelCredential` additionally verifies
  // the requested credentialId resolves to a `model_provider_credentials`
  // row owned by the run's org AND is pinned to this run.
  //
  // Remote-origin runs execute on the customer's host with their own
  // model provider (e.g. local Claude Code subscription) — they have no
  // platform sidecar to consume these tokens, and `model_credential_id`
  // is always NULL for that origin. Rejecting them up-front prevents a
  // leaked remote run-token from being used to enumerate the org's
  // OAuth credentials (the per-run pin check is bypassed when the
  // pin is NULL).

  router.get("/oauth-token/:credentialId", async (c) => {
    const { run } = await verifyRunToken(c);
    assertPlatformOriginOAuthAccess(run.runOrigin);
    const credentialId = c.req.param("credentialId");
    await assertOAuthModelCredential(credentialId, run.orgId, run.modelCredentialId);
    return c.json(await resolveOAuthTokenForSidecar(credentialId, run.orgId));
  });

  router.post("/oauth-token/:credentialId/refresh", async (c) => {
    const { run } = await verifyRunToken(c);
    assertPlatformOriginOAuthAccess(run.runOrigin);
    const credentialId = c.req.param("credentialId");
    await assertOAuthModelCredential(credentialId, run.orgId, run.modelCredentialId);
    return c.json(await forceRefreshOAuthModelProviderToken(credentialId, run.orgId));
  });

  /**
   * Pin: the running agent must declare this integration in
   * `dependencies.integrations` AND it must be installed in the run's
   * application. Same guard used by /integration-bundle and the Phase 1.5
   * /integration-credentials endpoints to keep a leaked run token from
   * enumerating integration secrets across the org.
   */
  async function assertAgentDeclaresIntegration(
    packageId: string,
    run: { packageId: string; orgId: string; applicationId: string },
    runId: string,
  ): Promise<void> {
    const agent = await getPackage(run.packageId, run.orgId, { includeEphemeral: true });
    if (!agent) throw notFound("Agent not found");
    const deps = asRecord(asRecord(agent.manifest).dependencies);
    const integrations = asRecord(deps.integrations);
    if (!(packageId in integrations)) {
      logger.warn("Integration credentials request rejected — not declared by agent", {
        runId,
        packageId,
        agentId: agent.id,
      });
      throw notFound(`Integration '${packageId}' is not a dependency of the running agent`);
    }
    const [installRow] = await db
      .select({ packageId: applicationPackages.packageId })
      .from(applicationPackages)
      .where(
        and(
          eq(applicationPackages.applicationId, run.applicationId),
          eq(applicationPackages.packageId, packageId),
        ),
      )
      .limit(1);
    if (!installRow) {
      throw notFound(`Integration '${packageId}' is not installed in this application`);
    }
  }

  // GET /internal/integration-credentials/:scope/:name — Phase 1.5
  // Sidecar-only. Returns the LIVE credential payload + per-auth HTTP
  // delivery plans for an integration the running agent depends on.
  // OAuth tokens are refreshed proactively if within the lead window;
  // POST .../refresh forces a refresh regardless.
  router.get("/integration-credentials/:scope{@[^/]+}/:name", async (c) => {
    const { runId, run } = await verifyRunToken(c);
    const packageId = `${c.req.param("scope")}/${c.req.param("name")}`;
    await assertAgentDeclaresIntegration(packageId, run, runId);
    const actor: Actor | null = actorFromIds(run.userId, run.endUserId);
    const result = await resolveLiveIntegrationCredentials(packageId, {
      runId,
      orgId: run.orgId,
      applicationId: run.applicationId,
      agentPackageId: run.packageId,
      actor,
      resolvedConnections: run.resolvedConnections,
    });
    logger.info("Integration credentials delivered", {
      runId,
      packageId,
      authCount: result.auths.length,
      deliveryPlanCount: Object.keys(result.deliveryPlans).length,
    });
    return c.json(result);
  });

  // POST /internal/integration-credentials/:scope/:name/refresh — Phase 1.5
  // Sidecar-only. Force-refresh every OAuth2 auth on this integration,
  // then return the freshly-resolved payload. Called by the MITM
  // listener's `refreshOnUnauthorized` hook when upstream returns 401.
  router.post("/integration-credentials/:scope{@[^/]+}/:name/refresh", async (c) => {
    const { runId, run } = await verifyRunToken(c);
    const packageId = `${c.req.param("scope")}/${c.req.param("name")}`;
    await assertAgentDeclaresIntegration(packageId, run, runId);
    const actor: Actor | null = actorFromIds(run.userId, run.endUserId);
    const result = await resolveLiveIntegrationCredentials(
      packageId,
      {
        runId,
        orgId: run.orgId,
        applicationId: run.applicationId,
        agentPackageId: run.packageId,
        actor,
        resolvedConnections: run.resolvedConnections,
      },
      { forceRefresh: true },
    );
    logger.info("Integration credentials refreshed", {
      runId,
      packageId,
      authCount: result.auths.length,
    });
    return c.json(result);
  });

  // GET /internal/integration-bundle/:scope/:name — Phase 1.4
  // Returns the integration's .afps bundle bytes. Authorised by the same
  // Bearer run-token as the credentials surface; additionally verifies
  // the run's agent declares this integration as a dependency so a
  // leaked run token can't enumerate arbitrary integration source.
  router.get("/integration-bundle/:scope{@[^/]+}/:name", async (c) => {
    const { runId, run } = await verifyRunToken(c);
    const packageId = `${c.req.param("scope")}/${c.req.param("name")}`;
    await assertAgentDeclaresIntegration(packageId, run, runId);

    // Resolve bytes: system package from in-memory map, local from S3
    const sys = getSystemPackages().get(packageId);
    if (sys?.zipBuffer) {
      logger.info("Integration bundle delivered (system)", {
        runId,
        packageId,
        bytes: sys.zipBuffer.length,
      });
      return new Response(Buffer.from(sys.zipBuffer), {
        status: 200,
        headers: { "Content-Type": "application/zip" },
      });
    }
    const [latest] = await db
      .select({ version: packageVersions.version, integrity: packageVersions.integrity })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, packageId), sql`${packageVersions.yanked} = false`))
      .orderBy(sql`${packageVersions.createdAt} DESC`)
      .limit(1);
    if (!latest) throw notFound(`No published version for '${packageId}'`);
    const bytes = await downloadVersionZip(packageId, latest.version, latest.integrity);
    if (!bytes) throw notFound(`Bundle bytes unavailable for '${packageId}'`);
    logger.info("Integration bundle delivered (storage)", {
      runId,
      packageId,
      version: latest.version,
      bytes: bytes.length,
    });
    return new Response(bytes, { status: 200, headers: { "Content-Type": "application/zip" } });
  });

  return router;
}

/**
 * Reject `/internal/oauth-token` traffic from remote-origin runs. They
 * execute on the customer's host with their own model provider and never
 * legitimately need a platform-stored OAuth token. The per-run pin
 * (`runs.model_credential_id`) is intentionally NULL for that origin,
 * which would otherwise let the run-token bearer enumerate every OAuth
 * credential in the org via `/internal/oauth-token/:credentialId`.
 */
function assertPlatformOriginOAuthAccess(runOrigin: "platform" | "remote"): void {
  if (runOrigin !== "platform") {
    throw forbidden("OAuth model provider tokens are not available for remote runs");
  }
}

/**
 * Verify a `model_provider_credentials` row exists and is reachable by
 * this run. Three layers of checks:
 *
 *   1. Per-run pinning: when `pinnedCredentialId` is set (platform-origin
 *      runs that resolved to an OAuth model), the requested credentialId
 *      MUST match. This prevents a leaked run token from enumerating any
 *      other OAuth credential the org might own.
 *   2. Org-membership: the credential row exists and `orgId === runOrgId`.
 *   3. UUID well-formedness: malformed path params surface as 404 not 500.
 *
 * `pinnedCredentialId === null` is only reachable from platform-origin
 * runs that resolved to an API-key model (no OAuth credential to bind
 * against). Remote-origin runs (where the pin is structurally absent)
 * are rejected upstream by `assertPlatformOriginOAuthAccess`.
 */
async function assertOAuthModelCredential(
  credentialId: string,
  runOrgId: string,
  pinnedCredentialId: string | null,
): Promise<void> {
  if (pinnedCredentialId !== null && pinnedCredentialId !== credentialId) {
    throw forbidden(`Credential ${credentialId} not pinned to this run`);
  }
  let row: { orgId: string } | undefined;
  try {
    [row] = await db
      .select({ orgId: modelProviderCredentials.orgId })
      .from(modelProviderCredentials)
      .where(eq(modelProviderCredentials.id, credentialId))
      .limit(1);
  } catch (err) {
    // PG `invalid_text_representation` (22P02) when the path param is not
    // a valid UUID — treat as not-found rather than leaking a 500. Drizzle
    // wraps the underlying postgres.js error via `new Error(…, { cause })`.
    const code =
      (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "22P02") {
      throw notFound(`OAuth model provider credential ${credentialId} not found`);
    }
    throw err;
  }
  if (!row) {
    throw notFound(`OAuth model provider credential ${credentialId} not found`);
  }
  if (row.orgId !== runOrgId) {
    throw forbidden(`Credential ${credentialId} not in run org`);
  }
}
