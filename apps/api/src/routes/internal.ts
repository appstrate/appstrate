// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { Context } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials, packages, packageVersions, runs } from "@appstrate/db/schema";
import { asRecord } from "@appstrate/core/safe-json";
import { parseBearer } from "@appstrate/core/bearer";
import { downloadVersionZip } from "../services/package-storage.ts";
import { getSystemPackages } from "../services/system-packages.ts";
import { logger } from "../lib/logger.ts";
import { isInvalidTextRepresentation } from "../lib/db-helpers.ts";
import { listResponse } from "../lib/list-response.ts";
import { parseListPagination } from "../lib/list-query.ts";
import { parseSignedToken } from "../lib/run-token.ts";
import { rateLimitByBearer } from "../middleware/rate-limit.ts";
import {
  getRecentRuns,
  recordRunDegradedIntegration,
  runAgentIdentity,
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
import {
  getRunEffectiveAgent,
  runAgentGoneDetail,
  runPinnedVersionGoneDetail,
} from "../services/run-effective-agent.ts";
import type { RunAgentGone, RunPinnedVersionGone } from "../services/run-effective-agent.ts";
import {
  ApiError,
  unauthorized,
  forbidden,
  notFound,
  conflict,
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
import { orgOrSystemFilter } from "../lib/package-helpers.ts";
import {
  isConnectId,
  readConnectRunGrant,
  type ConnectRunGrant,
} from "../services/connect/connect-run-grant.ts";

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
    spaceId: string;
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
  const rawToken = parseBearer(c.req.header("Authorization"));
  if (!rawToken) {
    throw unauthorized("Missing run token");
  }

  // Verify HMAC signature before DB lookup
  const runId = parseSignedToken(rawToken);
  if (!runId) {
    throw unauthorized("Invalid run token");
  }

  const rows = await db
    .select({
      packageId: runs.packageId,
      // The INSERT-time `@scope/name` snapshot. `runs.package_id` is
      // `ON DELETE SET NULL` (schema/runs.ts), so deleting the agent mid-run
      // nulls the column while the run keeps executing — and this token stays
      // valid until the run leaves `running`. Without the snapshot the guards
      // below would report the agent id as `null`.
      agentScope: runs.agentScope,
      agentName: runs.agentName,
      userId: runs.userId,
      endUserId: runs.endUserId,
      orgId: runs.orgId,
      spaceId: runs.spaceId,
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
      // Shared with `getRunSinkContext` (one fallback chain, one sentinel). The
      // previous `run.packageId!` asserted away a null that this endpoint can
      // genuinely see, and it reached `getRunEffectiveAgent` — which now
      // reports `agent_deleted` and needs a printable id for its message.
      packageId: runAgentIdentity(run),
      userId: run.userId,
      endUserId: run.endUserId,
      orgId: run.orgId,
      spaceId: run.spaceId,
      status: run.status,
      modelCredentialId: run.modelCredentialId ?? null,
      runOrigin: run.runOrigin,
      versionRef: run.versionRef ?? null,
      resolvedConnections: run.resolvedConnections ?? null,
      resolvedIntegrationVersions: run.resolvedIntegrationVersions ?? null,
    },
  };
}

/**
 * The caller behind a connect-run token, when the request carries one.
 *
 * `/internal/*` serves TWO disjoint token populations and they are never
 * interchangeable:
 *
 *   - a RUN token, whose id resolves to a `runs` row and whose reach is
 *     decided by walking the run's effective agent manifest;
 *   - a CONNECT-RUN token, whose id has no row anywhere and no agent at all,
 *     and whose reach is the {@link ConnectRunGrant} the launcher published for
 *     it (see `services/connect/connect-run-grant.ts`).
 *
 * Neither can be smuggled into the other's branch. The signature covers the
 * whole id (`lib/run-token.ts`), so only ids the platform minted verify at all,
 * and the two mint shapes are disjoint (`run_…` vs `connect_…`). Even if that
 * were not so, the two lookups hit different stores: a run id finds no grant
 * (this function refuses), and a connect id finds no `runs` row
 * (`verifyRunToken` 404s). Both directions fail closed structurally, not by
 * convention.
 */
interface ConnectCaller {
  connectId: string;
  grant: ConnectRunGrant;
}

/**
 * Resolve the Bearer to a connect-run caller, or `null` when it is not one —
 * in which case the route falls through to `verifyRunToken` UNCHANGED, keeping
 * the real-run path exactly as wide as it was.
 *
 * A missing / unsigned / unparseable Authorization header returns `null` too,
 * so `verifyRunToken` keeps owning those refusals and there is one place that
 * words them. What this function does NOT do is fall through for a VALID
 * connect token with no grant: that is a hard refusal here, because falling
 * through would report it as "Run not found" and hide the real cause (the
 * connect run is over, or never published a grant).
 */
async function connectCallerOrNull(c: Context): Promise<ConnectCaller | null> {
  const rawToken = parseBearer(c.req.header("Authorization"));
  if (!rawToken) return null;
  const id = parseSignedToken(rawToken);
  if (id === null || !isConnectId(id)) return null;
  const grant = await readConnectRunGrant(id);
  if (!grant) {
    // Absent, expired, or unreadable — one refusal for all three (the grant
    // reader collapses them deliberately). 404 mirrors the run path's "Run not
    // found" so the sidecar's status branching is unchanged.
    logger.warn("connect-run request rejected — no live authorization grant", { connectId: id });
    throw notFound("Connect run not found");
  }
  return { connectId: id, grant };
}

/**
 * Authorise a bundle fetch against the connect run's grant. Replaces
 * `assertAgentReferencesMcpServer`, which has no agent to consult here.
 *
 * Exact match on both axes, no ranges, no "latest":
 *   - the package must be THE mcp-server the launcher's resolver picked;
 *   - a grant carrying a concrete version admits only that version;
 *   - a grant carrying `null` (system mcp-server) admits only the byte route's
 *     boot-registry short-circuit, so it refuses a `?version=` outright rather
 *     than letting the request reach the `package_versions` lookup, where the
 *     grant would have become "any version of this package".
 */
function assertConnectGrantCoversMcpServer(
  mcpServerId: string,
  requestedVersion: string | undefined,
  caller: ConnectCaller,
): void {
  const { grant, connectId } = caller;
  if (grant.mcpServerId !== mcpServerId) {
    logger.warn("mcp-server bundle request rejected — not this connect run's server", {
      connectId,
      mcpServerId,
      grantedMcpServerId: grant.mcpServerId,
    });
    throw notFound(`mcp-server '${mcpServerId}' is not the server this connect run resolved`);
  }
  if (grant.mcpServerVersion === null) {
    if (requestedVersion) {
      logger.warn("mcp-server bundle request rejected — system grant carries no version", {
        connectId,
        mcpServerId,
        requestedVersion,
      });
      throw notFound(
        `Version '${requestedVersion}' is not the version this connect run resolved for '${mcpServerId}'`,
      );
    }
    return;
  }
  if (requestedVersion !== grant.mcpServerVersion) {
    logger.warn("mcp-server bundle request rejected — version outside the grant", {
      connectId,
      mcpServerId,
      requestedVersion: requestedVersion ?? null,
      grantedVersion: grant.mcpServerVersion,
    });
    throw notFound(
      `Version '${requestedVersion ?? ""}' is not the version this connect run resolved for '${mcpServerId}'`,
    );
  }
}

/**
 * Authorise a credentials read against the connect run's grant. Replaces
 * `assertAgentDeclaresIntegration` — one integration, exact match.
 */
function assertConnectGrantCoversIntegration(packageId: string, caller: ConnectCaller): void {
  if (caller.grant.integrationId !== packageId) {
    logger.warn("integration credentials request rejected — not this connect run's integration", {
      connectId: caller.connectId,
      packageId,
      grantedIntegrationId: caller.grant.integrationId,
    });
    throw notFound(`Integration '${packageId}' is not the integration this connect run connects`);
  }
}

/**
 * What a connect run gets from `GET /internal/integration-credentials/*`:
 * nothing.
 *
 * This is not a degradation, it is the correct answer. A connect run exists to
 * MINT the credential that does not exist yet; the login secret it needs
 * travels in `CONNECT_LOGIN_JSON` and is substituted proxy-side, and the
 * session it captures is installed in-process by `runConnectLogin` →
 * `setSessionOutputs`. The sidecar calls this endpoint anyway because
 * `runConnectOnce` seeds the shared credentials Source from it before the
 * spawn and throws on any non-2xx — so the endpoint must answer, and an empty
 * payload is both what the flow needs and the least this token can be given.
 * Resolving the LIVE credential here would hand a plaintext secret to a path
 * that has no use for it.
 *
 * `200` + empty rather than `204`: the sidecar's success path is
 * `normalizeIntegrationCredentialsWire(await res.json())` — unconditional,
 * with no no-content branch — so a bodyless 2xx aborts boot exactly like a 4xx
 * (pinned in `runtime-pi/sidecar/test/integration-credentials-source.test.ts`,
 * "REQUIRES a JSON body on success"). A `204` would therefore need a matching
 * change in a separately built image the platform is version-locked to at
 * boot. It is not a narrower shape, only a differently broken one.
 */
const EMPTY_CREDENTIALS_WIRE = {
  auths: [] as const,
  deliveryPlans: {},
  expiresAtEpochMs: {},
};

export function createInternalRouter() {
  const router = new Hono();

  // Rate limit all internal endpoints (200 req/min per token)
  router.use("/*", rateLimitByBearer(200));

  // GET /internal/run-history — called from inside containers
  // Auth: Bearer <signedToken> (HMAC-verified, then checked against runs table)
  router.get("/run-history", async (c) => {
    const { runId, run } = await verifyRunToken(c);

    // Parse query parameters
    const fieldsParam = c.req.query("fields");

    const { limit } = parseListPagination(c, { defaultLimit: 10, maxLimit: 50 });

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
        { orgId: run.orgId, spaceId: run.spaceId },
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

    const { limit } = parseListPagination(c, {
      defaultLimit: RECALL_LIMIT_DEFAULT,
      maxLimit: RECALL_LIMIT_MAX,
    });

    try {
      const actor: Actor | null = actorFromIds(run.userId, run.endUserId);
      const memories = await recallMemories(run.packageId, run.spaceId, scopeFromActor(actor), {
        ...(query !== undefined ? { query } : {}),
        limit,
      });

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
   * space. Same guard used by /mcp-server-bundle and the
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
    run: { packageId: string; orgId: string; spaceId: string; versionRef: string | null },
    runId: string,
  ): Promise<void> {
    const effective = await getRunEffectiveAgent(run);
    if (effective.status !== "ok") throw runDefinitionGone(effective, runId);
    const deps = asRecord(asRecord(effective.manifest).dependencies);
    const integrations = asRecord(deps.integrations);
    if (!(packageId in integrations)) {
      logger.warn("Integration credentials request rejected — not declared by agent", {
        runId,
        packageId,
        agentId: effective.id,
      });
      throw notFound(`Integration '${packageId}' is not a dependency of the running agent`);
    }
    // Same activation rule as the spawn resolver / agent readiness (single
    // source of truth): an installed-and-enabled row OR a system integration
    // auto-active with no row. A disabled row stays inactive.
    if (!(await isIntegrationActive(packageId, run.spaceId))) {
      throw notFound(`Integration '${packageId}' is not installed in this space`);
    }
  }

  /**
   * A terminal credential failure (410) is recorded on the run exactly once,
   * from whichever endpoint sees it. `resolveLiveIntegrationCredentials` has
   * already flagged the CONNECTION `needsReconnection` by the time it throws;
   * this stamps the RUN's `metadata.degraded_integrations[]` so the finished
   * run surfaces a reconnect banner instead of only the connection list doing
   * it. Both endpoints route through here: the boot GET can be terminal too
   * (undecryptable credentials), and a 410 the run never records is a failure
   * the user only discovers by re-reading the agent's transcript.
   */
  async function recordTerminalCredentialFailure(
    err: unknown,
    runId: string,
    packageId: string,
  ): Promise<void> {
    if (err instanceof ApiError && err.status === 410) {
      await recordRunDegradedIntegration(runId, packageId);
    }
  }

  // GET /internal/integration-credentials/:scope/:name
  // Sidecar-only. Returns the LIVE credential payload + per-auth HTTP
  // delivery plans for an integration the running agent depends on.
  // OAuth tokens are refreshed proactively if within the lead window;
  // POST .../refresh forces a refresh regardless.
  //
  // A 2xx here always carries a usable credential surface: an EMPTY payload
  // means the integration declares no auth, and nothing else. Every state where
  // a credential was expected but could not be produced fails loud — 404 (no
  // connection for the actor / the run's pinned connection is gone), 409
  // `integration_auth_undeclared` (the pinned manifest version no longer
  // declares the connection's auth), 410 (dead credential, connection flagged).
  // The sidecar treats an empty payload as "no `delivery.http` auths, skip the
  // MITM listener", so answering 200-with-empty for any of those booted the run
  // with zero credentials and left the agent reporting a phantom upstream
  // outage.
  router.get(`/integration-credentials/${SCOPED_PACKAGE_ROUTE}`, async (c) => {
    const packageId = `${c.req.param("scope")}/${c.req.param("name")}`;
    // Connect-run branch — grant-authorised, empty payload. See
    // EMPTY_CREDENTIALS_WIRE for why "empty" is the answer and not a fallback.
    const connect = await connectCallerOrNull(c);
    if (connect) {
      assertConnectGrantCoversIntegration(packageId, connect);
      logger.info("Integration credentials delivered (connect run, empty)", {
        connectId: connect.connectId,
        packageId,
      });
      return c.json(serializeIntegrationCredentialsWire(EMPTY_CREDENTIALS_WIRE));
    }
    const { runId, run } = await verifyRunToken(c);
    await assertAgentDeclaresIntegration(packageId, run, runId);
    const actor: Actor | null = actorFromIds(run.userId, run.endUserId);
    let result;
    try {
      result = await resolveLiveIntegrationCredentials(packageId, {
        runId,
        orgId: run.orgId,
        spaceId: run.spaceId,
        agentPackageId: run.packageId,
        actor,
        resolvedConnections: run.resolvedConnections,
        resolvedIntegrationVersions: run.resolvedIntegrationVersions,
      });
    } catch (err) {
      await recordTerminalCredentialFailure(err, runId, packageId);
      throw err;
    }
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
  // `needsReconnection` and throws 410, which `recordTerminalCredentialFailure`
  // stamps onto the run. The sidecar maps the 410 to "don't retry"; the
  // next-launch readiness gate + live badge do the user-facing surfacing.
  router.post(`/integration-credentials/${SCOPED_PACKAGE_ROUTE}/refresh`, async (c) => {
    const packageId = `${c.req.param("scope")}/${c.req.param("name")}`;
    // A connect run has no stored credential to force-refresh: the platform
    // holds nothing for this connection yet, which is the whole reason the run
    // exists. Refusing explicitly beats letting it fall into `verifyRunToken`'s
    // "Run not found", which would name the wrong cause. The sidecar's
    // `doRefresh` treats any non-2xx as "don't retry now" and leaves the
    // upstream response untouched, so this is a fail-closed no-op for it.
    const connect = await connectCallerOrNull(c);
    if (connect) {
      logger.warn("Integration credential refresh refused for a connect run", {
        connectId: connect.connectId,
        packageId,
      });
      throw conflict(
        "connect_run_no_refresh",
        `A connect run holds no stored credential for '${packageId}' to refresh — its session is minted in-process by the login tool.`,
      );
    }
    const { runId, run } = await verifyRunToken(c);
    await assertAgentDeclaresIntegration(packageId, run, runId);
    const actor: Actor | null = actorFromIds(run.userId, run.endUserId);
    let result;
    try {
      result = await resolveLiveIntegrationCredentials(
        packageId,
        {
          runId,
          orgId: run.orgId,
          spaceId: run.spaceId,
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
      await recordTerminalCredentialFailure(err, runId, packageId);
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
  //
  // An ephemeral CONNECT run (`runAt: "link"` connect.tool login) reaches this
  // endpoint too, and has no `runs` row and no agent for either half of that
  // check to read. It authorises against its launcher-published grant instead
  // — one mcp-server, one concrete version — which is strictly narrower than
  // the manifest walk, never wider.
  router.get(`/mcp-server-bundle/${SCOPED_PACKAGE_ROUTE}`, async (c) => {
    const mcpServerId = `${c.req.param("scope")}/${c.req.param("name")}`;
    // Connect-run branch — the grant IS the authorization (there is no agent
    // whose dependencies could be walked). Byte delivery below is shared
    // verbatim with the run path; only the authorization differs.
    const connect = await connectCallerOrNull(c);
    if (connect) {
      assertConnectGrantCoversMcpServer(mcpServerId, c.req.query("version")?.trim(), connect);
      return serveMcpServerBundle(c, mcpServerId, {
        connectId: connect.connectId,
        orgId: connect.grant.orgId,
      });
    }
    const { runId, run } = await verifyRunToken(c);
    await assertAgentReferencesMcpServer(mcpServerId, run, runId);
    return serveMcpServerBundle(c, mcpServerId, { runId });
  });

  /**
   * Deliver an mcp-server package's bundle bytes. The "who may read what"
   * decision has ALREADY happened — `assertAgentReferencesMcpServer` for a run
   * token, `assertConnectGrantCoversMcpServer` for a connect token — so the
   * two callers cannot drift on version pinning or the system short-circuit.
   *
   * `caller` is log attribution AND, for a connect token, the tenant scope the
   * version lookup below is filtered by. The asymmetry is deliberate and is
   * explained at that query.
   */
  async function serveMcpServerBundle(
    c: Context,
    mcpServerId: string,
    caller: { runId: string } | { connectId: string; orgId: string },
  ): Promise<Response> {
    // Resolve bytes: system package from in-memory map, local from S3
    const sys = getSystemPackages().get(mcpServerId);
    if (sys?.zipBuffer) {
      logger.info("mcp-server bundle delivered (system)", {
        ...caller,
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
    // by exact match (yank-visibility already applied upstream). Past the system
    // short-circuit above, an absent `?version=` is unanswerable rather than a
    // request for "latest": serving the newest published version is precisely
    // the manifest/bytes skew #588 closed, so it fails loudly instead.
    const requestedVersion = c.req.query("version")?.trim();
    if (!requestedVersion) {
      throw invalidRequest(
        `Query parameter 'version' is required for '${mcpServerId}': send the concrete ` +
          `version the run resolved at kickoff (the spawn spec's \`server.version\`). Only ` +
          `system mcp-servers, served from the in-memory boot registry, may omit it.`,
        "version",
      );
    }
    // Tenant scope on the VERSION lookup itself — the same technique, on the
    // same two tables, that `resolvePublishedManifest` uses (see
    // `integration-service.ts`: "so the two reads can never skew across a
    // concurrent delete/recreate of the package id"). A pre-check on `packages`
    // followed by an unfiltered version read would be exactly the TOCTOU this
    // avoids, which is why the filter is here and not in a separate guard.
    //
    // Only the CONNECT branch binds it, and that is not an oversight:
    //   - the run path's org boundary is `assertAgentReferencesMcpServer`,
    //     which walks the run's own agent + space. Binding `run.orgId` here as
    //     well would be a second name for a boundary that path already holds,
    //     and this endpoint's contract must not shift by one row.
    //   - the connect path has no agent to walk. Its grant carries the org the
    //     launcher's ORG-SCOPED resolver ran in, and this compares that against
    //     an independently derived fact — the org owning the row being served,
    //     read now rather than at grant time. `orgOrSystemFilter` admits system
    //     packages (`org_id IS NULL`), matching the resolver that wrote the
    //     grant, so a system mcp-server stays reachable.
    //
    // The join itself changes nothing for the run path: `package_versions
    // .package_id` is `ON DELETE CASCADE` (schema/packages.ts), so every row
    // has a parent and an unfiltered inner join drops none of them.
    const tenantScope = "orgId" in caller ? caller.orgId : null;
    const [resolved] = await db
      .select({ version: packageVersions.version, integrity: packageVersions.integrity })
      .from(packageVersions)
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .where(
        and(
          eq(packageVersions.packageId, mcpServerId),
          eq(packageVersions.version, requestedVersion),
          ...(tenantScope ? [orgOrSystemFilter(tenantScope)] : []),
        ),
      )
      .limit(1);
    if (!resolved) {
      throw notFound(`Version '${requestedVersion}' not found for '${mcpServerId}'`);
    }
    const bytes = await downloadVersionZip(mcpServerId, resolved.version, resolved.integrity);
    if (!bytes) throw notFound(`Bundle bytes unavailable for '${mcpServerId}'`);
    logger.info("mcp-server bundle delivered (storage)", {
      ...caller,
      mcpServerId,
      version: resolved.version,
      bytes: bytes.length,
    });
    return new Response(bytes, { status: 200, headers: { "Content-Type": "application/zip" } });
  }

  /**
   * Authorise an mcp-server bundle fetch: the running agent must declare at
   * least one integration (in `dependencies.integrations`) that (a) is
   * installed in the run's space AND (b) references this mcp-server via
   * `source.server.name`. This keeps a leaked run token from enumerating
   * arbitrary server source across the org.
   */
  async function assertAgentReferencesMcpServer(
    mcpServerId: string,
    run: {
      packageId: string;
      orgId: string;
      spaceId: string;
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
    const effective = await getRunEffectiveAgent(run);
    if (effective.status !== "ok") throw runDefinitionGone(effective, runId);
    const deps = asRecord(asRecord(effective.manifest).dependencies);
    const integrations = asRecord(deps.integrations);
    for (const integrationId of Object.keys(integrations)) {
      // Same activation rule as everywhere else (installed-and-enabled row, or
      // system integration auto-active with no row); skip inactive ones.
      if (!(await isIntegrationActive(integrationId, run.spaceId))) continue;
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
      agentId: effective.id,
    });
    throw notFound(`mcp-server '${mcpServerId}' is not referenced by the running agent`);
  }

  return router;
}

/**
 * Both absent states throw here: the run-token guards above need the manifest
 * to decide what the token may reach. The only place allowed to translate them.
 *
 * 409 for both, NOT 410 and NOT 404. `410` is already load-bearing on
 * `/internal/integration-credentials/*` with "the credential was revoked
 * upstream, stop retrying and reconnect" semantics — the sidecar branches on
 * the bare status (`doRefresh` in `integration-credentials-source.ts`) and
 * would mislabel a gone definition as a dead connection. `404` is what this
 * same endpoint already returns for "that integration is not a dependency of
 * the running agent" / "not installed", so reusing it for a deleted agent
 * would put two unrelated causes behind one status — the illegibility this
 * whole path exists to remove (the pre-existing `notFound("Agent not
 * found")` was exactly that). Keeping one status and splitting the code
 * leaves the sidecar's status branching untouched while still naming the
 * cause.
 */
function runDefinitionGone(gone: RunPinnedVersionGone | RunAgentGone, runId: string): ApiError {
  logger.warn("run's executed definition is no longer readable", {
    runId,
    packageId: gone.packageId,
    cause: gone.status,
    ...(gone.status === "version_deleted" ? { versionRef: gone.versionRef } : {}),
  });
  if (gone.status === "agent_deleted") {
    return conflict("run_agent_deleted", runAgentGoneDetail(gone));
  }
  return conflict("run_definition_gone", runPinnedVersionGoneDetail(gone));
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
