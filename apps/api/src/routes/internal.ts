// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { Hono } from "hono";
import type { Context } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials, packageVersions, runs } from "@appstrate/db/schema";
import { sql } from "drizzle-orm";
import { asRecord } from "@appstrate/core/safe-json";
import { downloadVersionZip } from "../services/package-storage.ts";
import { getSystemPackages } from "../services/system-packages.ts";
import { logger } from "../lib/logger.ts";
import { isInvalidTextRepresentation } from "../lib/db-helpers.ts";
import { listResponse } from "../lib/list-response.ts";
import { parseSignedToken } from "../lib/run-token.ts";
import { rateLimitByBearer } from "../middleware/rate-limit.ts";
import {
  getRecentRuns,
  recordRunDegradedIntegration,
  RUN_HISTORY_FIELDS,
  type RunHistoryField,
} from "../services/state/runs.ts";
import {
  recallMemories,
  RECALL_LIMIT_DEFAULT,
  RECALL_LIMIT_MAX,
  scopeFromActor,
  MAX_MEMORY_CONTENT,
} from "../services/state/package-persistence.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { getRunEffectiveAgent } from "../services/run-effective-agent.ts";
import {
  ApiError,
  unauthorized,
  forbidden,
  notFound,
  invalidRequest,
  internalError,
} from "../lib/errors.ts";
import { actorFromIds, type Actor } from "../lib/actor.ts";
import {
  forceRefreshOAuthModelProviderToken,
  resolveOAuthTokenForSidecar,
} from "../services/model-providers/token-resolver.ts";
import {
  resolveLiveIntegrationCredentials,
  serializeIntegrationCredentialsWire,
} from "../services/integration-credentials-resolver.ts";
import { readIntegrationManifestForRun } from "../services/integration-service.ts";
import { getLocalServerRef } from "../services/integration-manifest-helpers.ts";
import { isIntegrationActive } from "../services/integration-connections.ts";
import { SCOPED_PACKAGE_ROUTE } from "./scoped-package-route.ts";

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
     * The agent definition the run executes — `"draft"` or a concrete semver
     * stamped at kickoff (#636). The dependency guards read the manifest AT
     * this ref so a post-kickoff draft edit cannot retroactively change a
     * pinned run's authorization set.
     */
    versionRef: string | null;
    /**
     * Snapshot of the connection resolver output frozen at run kickoff
     * (#199). The credentials resolver uses it to honour admin pins and
     * per-run overrides past the kickoff handoff.
     */
    resolvedConnections: Record<string, { connectionId: string; source: string }> | null;
    /**
     * Snapshot of each declared integration's resolved manifest version frozen
     * at run kickoff (#686). The credentials resolver reads the integration
     * manifest AT this version so a mid-run MITM refresh sees the same
     * delivery/auth plan the spawn used.
     */
    resolvedIntegrationVersions: Record<
      string,
      { version: string | null; source: "version" | "draft" | "system" }
    > | null;
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
      versionRef: runs.versionRef,
      resolvedConnections: runs.resolvedConnections,
      resolvedIntegrationVersions: runs.resolvedIntegrationVersions,
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
      versionRef: run.versionRef ?? null,
      resolvedConnections: run.resolvedConnections ?? null,
      resolvedIntegrationVersions: run.resolvedIntegrationVersions ?? null,
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

    // Unknown field names fail loudly with 400 so a stale runner schema can't
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
          actor_type: m.actorType,
          actor_id: m.actorId,
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
  // is always NULL for that origin. Rejecting them up-front is defense in
  // depth: `assertOAuthModelCredential` already fails closed on a NULL
  // pin, so no run without a pinned OAuth credential can read any token.

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
   * application. Same guard used by /mcp-server-bundle and the
   * /integration-credentials endpoints to keep a leaked run token from
   * enumerating integration secrets across the org.
   *
   * "The running agent" means the definition the run EXECUTES —
   * `getRunEffectiveAgent` reads the `package_versions` snapshot when
   * `runs.version_ref` pins one, the draft otherwise. Reading the mutable
   * draft here let a post-kickoff draft edit change a pinned run's
   * authorization set in both directions: a dep removed from the draft
   * 404'd the boot credential fetch of a scheduled run pinned to a version
   * that still declares it, and a dep newly added to the draft widened what
   * a leaked run token of an old pinned run could enumerate.
   */
  async function assertAgentDeclaresIntegration(
    packageId: string,
    run: { packageId: string; orgId: string; applicationId: string; versionRef: string | null },
    runId: string,
  ): Promise<void> {
    const agent = await getRunEffectiveAgent(run);
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
    // Same activation rule as the spawn resolver / agent readiness (single
    // source of truth): an installed-and-enabled row OR a system integration
    // auto-active with no row. A disabled row stays inactive.
    if (!(await isIntegrationActive(packageId, run.applicationId))) {
      throw notFound(`Integration '${packageId}' is not installed in this application`);
    }
  }

  // GET /internal/integration-credentials/:scope/:name
  // Sidecar-only. Returns the LIVE credential payload + per-auth HTTP
  // delivery plans for an integration the running agent depends on.
  // OAuth tokens are refreshed proactively if within the lead window;
  // POST .../refresh forces a refresh regardless.
  router.get(`/integration-credentials/${SCOPED_PACKAGE_ROUTE}`, async (c) => {
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
      resolvedIntegrationVersions: run.resolvedIntegrationVersions,
    });
    logger.info("Integration credentials delivered", {
      runId,
      packageId,
      authCount: result.auths.length,
      deliveryPlanCount: Object.keys(result.deliveryPlans).length,
    });
    return c.json(serializeIntegrationCredentialsWire(result));
  });

  // POST /internal/integration-credentials/:scope/:name/refresh
  // Sidecar-only. Called by the sidecar (api_call adapter + MITM listener) when
  // an upstream 401 is seen. Force-refreshes the integration's credential and
  // returns the fresh payload (200). When the credential cannot be recovered —
  // a revoked OAuth refresh token, an unrefreshable OAuth auth, OR any
  // non-OAuth auth (api_key/basic), since there is nothing to refresh after a
  // 401 — `resolveLiveIntegrationCredentials` flags the connection
  // `needsReconnection` and throws 410. This is the SINGLE place a terminal
  // auth failure is recorded: we also stamp the run's
  // `metadata.degraded_integrations[]` so the finished run surfaces a reconnect
  // banner. The sidecar maps the 410 to "don't retry"; the next-launch
  // readiness gate + live badge do the user-facing surfacing.
  router.post(`/integration-credentials/${SCOPED_PACKAGE_ROUTE}/refresh`, async (c) => {
    const { runId, run } = await verifyRunToken(c);
    const packageId = `${c.req.param("scope")}/${c.req.param("name")}`;
    await assertAgentDeclaresIntegration(packageId, run, runId);
    const actor: Actor | null = actorFromIds(run.userId, run.endUserId);
    let result;
    try {
      result = await resolveLiveIntegrationCredentials(
        packageId,
        {
          runId,
          orgId: run.orgId,
          applicationId: run.applicationId,
          agentPackageId: run.packageId,
          actor,
          resolvedConnections: run.resolvedConnections,
          resolvedIntegrationVersions: run.resolvedIntegrationVersions,
        },
        { forceRefresh: true },
      );
    } catch (err) {
      // 410 = the connection was flagged needsReconnection (terminal). Record
      // it on the run so the run-detail banner can surface it, then re-throw so
      // the sidecar sees the 410 and stops retrying.
      if (err instanceof ApiError && err.status === 410) {
        await recordRunDegradedIntegration(runId, packageId);
      }
      throw err;
    }
    logger.info("Integration credentials refreshed", {
      runId,
      packageId,
      authCount: result.auths.length,
    });
    return c.json(serializeIntegrationCredentialsWire(result));
  });

  // GET /internal/mcp-server-bundle/:scope/:name
  // Returns the mcp-server package's .afps bundle bytes (the runnable MCP
  // server code). In AFPS a local-source integration references a SEPARATE
  // mcp-server package via `source.server.name`; the sidecar fetches that
  // package's bundle here before spawning a runner. Authorised by the same
  // Bearer run-token as the credentials surface; additionally verifies the
  // run's agent declares an installed integration that references this
  // mcp-server, so a leaked run token can't enumerate arbitrary server source.
  router.get(`/mcp-server-bundle/${SCOPED_PACKAGE_ROUTE}`, async (c) => {
    const { runId, run } = await verifyRunToken(c);
    const mcpServerId = `${c.req.param("scope")}/${c.req.param("name")}`;
    await assertAgentReferencesMcpServer(mcpServerId, run, runId);

    // Resolve bytes: system package from in-memory map, local from S3
    const sys = getSystemPackages().get(mcpServerId);
    if (sys?.zipBuffer) {
      logger.info("mcp-server bundle delivered (system)", {
        runId,
        mcpServerId,
        bytes: sys.zipBuffer.length,
      });
      return new Response(Buffer.from(sys.zipBuffer), {
        status: 200,
        headers: { "Content-Type": "application/zip" },
      });
    }
    // #588 — the spawn resolver pins the CONCRETE version (from
    // `source.server.version`) and the sidecar forwards it here as `?version=`,
    // so the runnable bytes match the version's manifest the resolver read. The
    // version is server-resolved at run kickoff (not caller-chosen); we serve it
    // by exact match (yank-visibility already applied upstream). Falling back to
    // "latest non-yanked" only when the query is absent keeps older sidecars
    // (and the pre-#588 path) working.
    const requestedVersion = c.req.query("version")?.trim();
    let resolved: { version: string; integrity: string } | undefined;
    if (requestedVersion) {
      [resolved] = await db
        .select({ version: packageVersions.version, integrity: packageVersions.integrity })
        .from(packageVersions)
        .where(
          and(
            eq(packageVersions.packageId, mcpServerId),
            eq(packageVersions.version, requestedVersion),
          ),
        )
        .limit(1);
      if (!resolved) {
        throw notFound(`Version '${requestedVersion}' not found for '${mcpServerId}'`);
      }
    } else {
      [resolved] = await db
        .select({ version: packageVersions.version, integrity: packageVersions.integrity })
        .from(packageVersions)
        .where(
          and(eq(packageVersions.packageId, mcpServerId), sql`${packageVersions.yanked} = false`),
        )
        // Tiebreak by the serial `id` (insertion order) so two versions
        // published in the same `createdAt` tick still resolve "latest"
        // deterministically — without it the ORDER BY is non-deterministic on
        // a tie and the most-recently-inserted version is not guaranteed.
        .orderBy(sql`${packageVersions.createdAt} DESC, ${packageVersions.id} DESC`)
        .limit(1);
      if (!resolved) throw notFound(`No published version for '${mcpServerId}'`);
    }
    const bytes = await downloadVersionZip(mcpServerId, resolved.version, resolved.integrity);
    if (!bytes) throw notFound(`Bundle bytes unavailable for '${mcpServerId}'`);
    logger.info("mcp-server bundle delivered (storage)", {
      runId,
      mcpServerId,
      version: resolved.version,
      pinned: Boolean(requestedVersion),
      bytes: bytes.length,
    });
    return new Response(bytes, { status: 200, headers: { "Content-Type": "application/zip" } });
  });

  /**
   * Authorise an mcp-server bundle fetch: the running agent must declare at
   * least one integration (in `dependencies.integrations`) that (a) is
   * installed in the run's application AND (b) references this mcp-server via
   * `source.server.name`. This keeps a leaked run token from enumerating
   * arbitrary server source across the org.
   */
  async function assertAgentReferencesMcpServer(
    mcpServerId: string,
    run: {
      packageId: string;
      orgId: string;
      applicationId: string;
      versionRef: string | null;
      resolvedIntegrationVersions: Record<
        string,
        { version: string | null; source: "version" | "draft" | "system" }
      > | null;
    },
    runId: string,
  ): Promise<void> {
    // Enumerate the deps of the definition the run EXECUTES (pinned snapshot
    // when `version_ref` is a concrete semver) — same rationale as
    // `assertAgentDeclaresIntegration` above.
    const agent = await getRunEffectiveAgent(run);
    if (!agent) throw notFound("Agent not found");
    const deps = asRecord(asRecord(agent.manifest).dependencies);
    const integrations = asRecord(deps.integrations);
    for (const integrationId of Object.keys(integrations)) {
      // Same activation rule as everywhere else (installed-and-enabled row, or
      // system integration auto-active with no row); skip inactive ones.
      if (!(await isIntegrationActive(integrationId, run.applicationId))) continue;
      // Read the integration manifest AT the version frozen for this run
      // (#686) so the authz check sees the same `source.server.name` the spawn
      // resolver did. No frozen entry (soft-resolved / legacy run) → draft.
      const res = await readIntegrationManifestForRun(
        integrationId,
        run.resolvedIntegrationVersions?.[integrationId],
      );
      if (!res.ok) continue;
      const ref = getLocalServerRef(res.manifest);
      if (ref?.name === mcpServerId) return;
    }
    logger.warn("mcp-server bundle request rejected — not referenced by agent", {
      runId,
      mcpServerId,
      agentId: agent.id,
    });
    throw notFound(`mcp-server '${mcpServerId}' is not referenced by the running agent`);
  }

  return router;
}

/**
 * Reject `/internal/oauth-token` traffic from remote-origin runs. They
 * execute on the customer's host with their own model provider and never
 * legitimately need a platform-stored OAuth token. The per-run pin
 * (`runs.model_credential_id`) is intentionally NULL for that origin —
 * `assertOAuthModelCredential` fails closed on a NULL pin, so this guard
 * is defense in depth that also produces a clearer, origin-specific error.
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
 *   1. Per-run pinning (fail-closed): only platform-origin runs that
 *      resolved to an OAuth model carry a pin (`runs.model_credential_id`),
 *      and the requested credentialId MUST equal it. A run with a NULL pin
 *      (platform-origin API-key-model run) has NO legitimate reason to read
 *      ANY OAuth credential, so it is rejected outright — a leaked run
 *      token from such a run must not be able to enumerate the org's OAuth
 *      credentials.
 *   2. Org-membership: the credential row exists and `orgId === runOrgId`.
 *   3. UUID well-formedness: malformed path params surface as 404 not 500.
 *
 * Remote-origin runs (where the pin is structurally absent) are already
 * rejected upstream by `assertPlatformOriginOAuthAccess`; the null-pin
 * rejection here makes the surface fail-closed even without that guard.
 */
async function assertOAuthModelCredential(
  credentialId: string,
  runOrgId: string,
  pinnedCredentialId: string | null,
): Promise<void> {
  // Fail closed: no pin ⇒ no OAuth credential access, ever. Narrowing the
  // pin to a non-null string HERE (instead of an `!== null &&` short-circuit
  // that silently skips the equality gate) means the lookup below can only
  // ever be keyed by the run's own pinned credential.
  if (pinnedCredentialId === null) {
    throw forbidden("Run has no OAuth model provider credential pinned");
  }
  const pinned: string = pinnedCredentialId;
  if (pinned !== credentialId) {
    throw forbidden(`Credential ${credentialId} not pinned to this run`);
  }
  let row: { orgId: string } | undefined;
  try {
    [row] = await db
      .select({ orgId: modelProviderCredentials.orgId })
      .from(modelProviderCredentials)
      // Keyed by the (non-null) pin — equal to the requested credentialId by
      // the gate above, so the run can only ever read its own credential.
      .where(eq(modelProviderCredentials.id, pinned))
      .limit(1);
  } catch (err) {
    // PG `invalid_text_representation` (22P02) when the path param is not
    // a valid UUID — treat as not-found rather than leaking a 500. Drizzle
    // wraps the underlying postgres.js error via `new Error(…, { cause })`,
    // so walk the cause chain via the shared detector.
    if (isInvalidTextRepresentation(err)) {
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
