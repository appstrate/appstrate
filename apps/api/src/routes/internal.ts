// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  modelProviderCredentials,
  packages,
  packageVersions,
  type runs,
} from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import { asRecord } from "@appstrate/core/safe-json";
import { readJsonBody } from "@appstrate/core/request-body";
import type { ApiCallFailureCode } from "@appstrate/afps-runtime/resolvers";
import { parseBearer } from "@appstrate/core/bearer";
import { zipArtifact } from "@appstrate/core/zip";
import { getLocalServer, scopeTokenSchema } from "@appstrate/core/integration";
import { downloadVersionZipForExecution } from "../services/package-storage.ts";
import { readPackageSnapshot } from "../services/package-files.ts";
import {
  getSystemPackages,
  listRuntimeBoundSystemIntegrationIds,
} from "../services/system-packages.ts";
import { logger } from "../lib/logger.ts";
import { isInvalidTextRepresentation } from "../lib/db-helpers.ts";
import { parseSignedToken } from "../lib/run-token.ts";
import { verifyRunToken } from "../lib/verify-run-token.ts";
import { requireRunBoundMember } from "../lib/run-bound-connection.ts";
import { trackAudit } from "../services/audit.ts";
import { recordConnectionCalls } from "../services/credential-proxy/call-journal.ts";
import { serveRunMcp } from "../services/run-tools-mcp.ts";
import { RUN_ROUTE_RATE_PER_MIN, rateLimitByBearer } from "../middleware/rate-limit.ts";
import {
  recordRunDegradedIntegration,
  recordRunScopeRequest,
  recordRunUnavailableTools,
} from "../services/state/runs.ts";
import { recordToolSnapshot } from "../services/integration-tool-snapshots.ts";
import {
  OBSERVED_TOOLS_MAX_BYTES,
  OBSERVED_TOOLS_MAX_COUNT,
  UNAVAILABLE_TOOL_REASONS,
  observedToolNameSchema,
  observedToolSchema,
} from "@appstrate/core/sidecar-types";
import { bodyLimit } from "../middleware/body-limit.ts";
import {
  getRunEffectiveAgent,
  runAgentGoneDetail,
  runPinnedVersionGoneDetail,
} from "../services/run-effective-agent.ts";
import type { RunAgentGone, RunPinnedVersionGone } from "../services/run-effective-agent.ts";
import {
  ApiError,
  forbidden,
  notFound,
  conflict,
  invalidRequest,
  methodNotAllowed,
} from "../lib/errors.ts";
import { actorFromIds, type Actor } from "../lib/actor.ts";
import {
  forceRefreshOAuthModelProviderToken,
  resolveOAuthTokenForSidecar,
} from "../services/model-providers/token-resolver.ts";
import {
  personalModelCredentialsAllowed,
  personalModelCredentialsDisabled,
  serializeOAuthTokenResponse,
} from "../services/model-providers/credentials.ts";
import {
  resolveLiveIntegrationCredentials,
  serializeIntegrationCredentialsWire,
} from "../services/integration-credentials-resolver.ts";
import {
  readIntegrationManifestForRun,
  type ResolvedIntegrationVersionMap,
} from "../services/integration-service.ts";
import {
  clearReachableUpstreamRejections,
  MAX_REQUESTED_SCOPES,
  recordRequestedScopes,
  isIntegrationActive,
} from "../services/integration-connections.ts";
import { SCOPED_PACKAGE_ROUTE } from "./scoped-package-route.ts";
import type { AppEnv } from "../types/index.ts";
import { orgOrSystemFilter } from "../lib/package-helpers.ts";
import {
  isConnectId,
  readConnectRunGrant,
  type ConnectRunGrant,
} from "../services/connect/connect-run-grant.ts";

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
 * Authorise a bundle fetch against the connect run's grant, which has no agent to consult.
 * Exact match on both axes, no ranges, no "latest":
 *   - the integration must be THE one the launcher built the spawn spec from;
 *   - a grant carrying a concrete version admits only that version;
 *   - a grant carrying `null` (a system integration, or a draft still unpublished) admits only
 *     the unversioned byte route, so it refuses a `?version=` outright rather than letting the
 *     request reach the `package_versions` lookup, where the grant would have become "any
 *     version of this integration".
 */
function assertConnectGrantCoversIntegrationBundle(
  integrationId: string,
  requestedVersion: string | undefined,
  caller: ConnectCaller,
): void {
  const { grant, connectId } = caller;
  if (grant.integrationId !== integrationId) {
    logger.warn("integration bundle request rejected — not this connect run's integration", {
      connectId,
      integrationId,
      grantedIntegrationId: grant.integrationId,
    });
    throw notFound(
      `Integration '${integrationId}' is not the integration this connect run connects`,
    );
  }
  assertBundleVersionPermitted(integrationId, grant.version, requestedVersion, { connectId });
}

/** The requested `?version=` must be exactly the permitted one (`null`: none may be named). */
function assertBundleVersionPermitted(
  integrationId: string,
  permitted: string | null,
  requested: string | undefined,
  caller: Record<string, string>,
): void {
  if ((requested ?? null) === permitted) return;
  logger.warn("integration bundle request rejected — version outside the authorised one", {
    ...caller,
    integrationId,
    requestedVersion: requested ?? null,
    permittedVersion: permitted,
  });
  throw notFound(
    `Version '${requested ?? ""}' is not the version this run resolved for '${integrationId}'`,
  );
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

/**
 * The body bound: the sidecar cuts `tools` at `OBSERVED_TOOLS_MAX_BYTES`; the rest is the envelope
 * (`truncated`, and up to `OBSERVED_TOOLS_MAX_COUNT` unavailable entries of ~300 bytes each),
 * which the margin covers with room for JSON escaping.
 */
const TOOLS_OBSERVED_MAX_BODY_BYTES = OBSERVED_TOOLS_MAX_BYTES + 256 * 1024;

export const toolsObservedSchema = z
  .strictObject({
    /**
     * The descriptors as the server returned them, each judged on its own: a malformed one is
     * dropped (the listing counts as truncated) and never refuses the report, which also carries the
     * run's unavailable tools. The platform fingerprints the rest itself. Absent for a local
     * integration, whose server's catalog is no listing of a remote one: only `unavailable` counts.
     */
    tools: z.array(z.unknown()).max(OBSERVED_TOOLS_MAX_COUNT).optional(),
    /** Whether the listing was cut short; meaningful only with `tools`. */
    truncated: z.boolean().optional(),
    unavailable: z
      .array(
        z.strictObject({ name: observedToolNameSchema, reason: z.enum(UNAVAILABLE_TOOL_REASONS) }),
      )
      .max(OBSERVED_TOOLS_MAX_COUNT),
  })
  .refine((body) => (body.tools === undefined) === (body.truncated === undefined), {
    message: "`truncated` qualifies `tools`: send both or neither",
    path: ["truncated"],
  });
/** A credential's revision as a credentials payload carries it (`credential_revision`). */
const credentialRevisionSchema = z.string().regex(/^[0-9a-f]{16}$/);

/** The `auth_method` of a call a platform run's sidecar journals: its run token. */
const RUN_SIDECAR_AUTH_METHOD = "run_token";

/** The failure codes after dispatch a sidecar reports as an outcome: the platform proxy's own. */
const DISPATCHED_FAILURE_CODES = [
  "unauthorized_target",
  "blocked_target",
  "upstream_unresolvable",
  "upstream_unreachable",
  "upstream_timeout",
] as const satisfies readonly ApiCallFailureCode[];

/** Most records one `POST /internal/integration-calls` takes. */
const MAX_INTEGRATION_CALLS_PER_BATCH = 100;

/**
 * Hard bound on a record's text fields. `recordConnectionCalls` truncates to the columns' own caps:
 * a long value is stored cut, never a reason to refuse the batch.
 */
const MAX_INTEGRATION_CALL_TEXT = 2048;

const integrationCallRecordSchema = z
  .object({
    integration_id: z.string().min(1).max(214),
    connection_id: z.uuid().nullable(),
    // An HTTP method token (RFC 9110 §9.1).
    method: z
      .string()
      .max(MAX_INTEGRATION_CALL_TEXT)
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
    // NULL: an operation of a local MCP server, whose upstream requests the sidecar does not see.
    host: z
      .string()
      .min(1)
      .max(MAX_INTEGRATION_CALL_TEXT)
      .regex(/^[^\s\p{Cc}]+$/u)
      .nullable(),
    // Any three-digit status an upstream answers (some answer outside 1xx-5xx, e.g. 999).
    outcome: z.union([z.string().regex(/^[0-9]{3}$/), z.enum(DISPATCHED_FAILURE_CODES)]),
    duration_ms: z.int().min(0).max(2_147_483_647),
    credential_revision: credentialRevisionSchema.optional(),
    required_scopes: z.array(scopeTokenSchema).min(1).max(MAX_REQUESTED_SCOPES).optional(),
  })
  .strict()
  .refine(
    (call) =>
      call.credential_revision === undefined ||
      (call.connection_id !== null && /^2[0-9]{2}$/.test(call.outcome)),
    {
      message: "`credential_revision` ends a streak: only on a 2xx outcome through a connection.",
      path: ["credential_revision"],
    },
  )
  .refine(
    (call) =>
      call.required_scopes === undefined || (call.connection_id !== null && call.outcome === "403"),
    {
      message:
        "`required_scopes` names a step-up demand: only on a 403 outcome through a connection.",
      path: ["required_scopes"],
    },
  );

export const integrationCallsBodySchema = z
  .object({
    calls: z.array(integrationCallRecordSchema).min(1).max(MAX_INTEGRATION_CALLS_PER_BATCH),
  })
  .strict();

export function createInternalRouter(ratePerMin = RUN_ROUTE_RATE_PER_MIN) {
  const router = new Hono<AppEnv>();

  // Rate limit all internal endpoints per run token and per concrete path
  // (`limiterPath` falls back to the path under a `*` pattern), so
  // `/internal/mcp` has a budget of its own, apart from the credential and
  // token fetches — the figure the remote mount of the same server has.
  router.use("/*", rateLimitByBearer(ratePerMin));

  // POST /internal/mcp — the run MCP server (`@appstrate/platform` tools) for
  // the sidecar. The run token names the run; `verifyRunToken` refuses a run
  // that is not `running`. Every other verb is a 405 (`Allow: POST`): the
  // stateless server has no GET stream and no session.
  router.post("/mcp", async (c) => {
    const { runId, run } = await verifyRunToken(c);
    return serveRunMcp(c, { ...run, id: runId });
  });
  router.all("/mcp", () => {
    throw methodNotAllowed(["POST"]);
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
    await assertOAuthModelCredential(credentialId, run);
    return c.json(
      serializeOAuthTokenResponse(await resolveOAuthTokenForSidecar(credentialId, run.orgId)),
    );
  });

  router.post("/oauth-token/:credentialId/refresh", async (c) => {
    const { run } = await verifyRunToken(c);
    assertPlatformOriginOAuthAccess(run.runOrigin);
    const credentialId = c.req.param("credentialId");
    await assertOAuthModelCredential(credentialId, run);
    return c.json(
      serializeOAuthTokenResponse(
        await forceRefreshOAuthModelProviderToken(credentialId, run.orgId),
      ),
    );
  });

  /**
   * Pin: the running agent must declare this integration in
   * `dependencies.integrations` AND it must be ACTIVE in the run's
   * space. Same guard used by /integration-bundle and the
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
      logger.warn("Integration request rejected — not declared by agent", {
        runId,
        packageId,
        agentId: effective.id,
      });
      throw notFound(`Integration '${packageId}' is not a dependency of the running agent`);
    }
    // Same activation rule as the spawn resolver / agent readiness (single
    // source of truth): an enabled row OR a system integration
    // auto-active with no row. A disabled row stays inactive.
    if (!(await isIntegrationActive(packageId, run.spaceId))) {
      throw notFound(`Integration '${packageId}' is not active in this space`);
    }
  }

  /**
   * A connect run holds no stored credential: the platform has nothing for this connection yet,
   * which is the whole reason the run exists. Refusing explicitly beats letting it fall into
   * `verifyRunToken`'s "Run not found", which would name the wrong cause. The sidecar treats any
   * non-2xx here as "don't retry now", so this is a fail-closed no-op for it.
   */
  async function refuseConnectRun(c: Context, packageId: string): Promise<void> {
    const connect = await connectCallerOrNull(c);
    if (!connect) return;
    logger.warn("Stored-credential request refused for a connect run", {
      connectId: connect.connectId,
      packageId,
      path: c.req.path,
    });
    throw conflict(
      "connect_run_no_refresh",
      `A connect run holds no stored credential for '${packageId}' — its session is minted in-process by the login tool.`,
    );
  }

  /** `?credential_revision`, when present; anything but a revision is a 400. */
  function credentialRevisionQuery(c: Context): string | undefined {
    const raw = c.req.query("credential_revision");
    if (raw === undefined) return undefined;
    const parsed = credentialRevisionSchema.safeParse(raw);
    if (!parsed.success) {
      throw invalidRequest(
        "`credential_revision` must be the revision a credentials payload carried.",
        "credential_revision",
      );
    }
    return parsed.data;
  }

  /** `?rejected_request=handshake` names the MCP handshake as the rejected request; else 400. */
  function rejectedHandshakeQuery(c: Context): boolean {
    const raw = c.req.query("rejected_request");
    if (raw === undefined) return false;
    if (raw !== "handshake") {
      throw invalidRequest(
        "`rejected_request` must be `handshake` when present.",
        "rejected_request",
      );
    }
    return true;
  }

  /** The run-bound member `?connection_id` names, else 400 — the platform never picks one. */
  function requireBoundConnection(
    c: Context,
    packageId: string,
    run: { resolvedConnections: typeof runs.$inferSelect.resolvedConnections },
    runId: string,
  ) {
    const parsed = z.uuid().safeParse(c.req.query("connection_id"));
    if (!parsed.success) {
      throw invalidRequest(
        "`connection_id` is required and must be the uuid of a connection this run bound to " +
          `'${packageId}'.`,
        "connection_id",
      );
    }
    return requireRunBoundMember({
      runId,
      packageId,
      connectionId: parsed.data.toLowerCase(),
      bound: run.resolvedConnections?.[packageId] ?? [],
      param: "connection_id",
    });
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
    orgId: string,
    runId: string,
    packageId: string,
  ): Promise<void> {
    if (err instanceof ApiError && err.status === 410) {
      await recordRunDegradedIntegration(orgId, runId, packageId);
    }
  }

  // GET /internal/integration-credentials/:scope/:name
  // Sidecar-only. Returns the LIVE credential payload + per-auth HTTP
  // delivery plans for ONE connection the run bound to an integration it depends on.
  // OAuth tokens are refreshed proactively if within the lead window;
  // POST .../refresh forces a refresh regardless.
  //
  // A 2xx on the run path always carries a usable credential surface. Every state
  // where a credential was expected but could not be produced fails loud — 400
  // (see `requireBoundConnection`), 404 (the bound connection is gone), 409
  // `integration_auth_undeclared` (the pinned manifest version no longer
  // declares the connection's auth), 410 (dead credential, connection flagged),
  // 503 (credential under a key id the keyring lacks, connection NOT flagged).
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
    const bound = requireBoundConnection(c, packageId, run, runId);
    const actor: Actor | null = actorFromIds(run.userId, run.endUserId);
    let result;
    try {
      result = await resolveLiveIntegrationCredentials(packageId, {
        runId,
        orgId: run.orgId,
        spaceId: run.spaceId,
        agentPackageId: run.packageId,
        actor,
        connectionId: bound.connectionId,
        connectionSource: bound.source,
        resolvedIntegrationVersions: run.resolvedIntegrationVersions,
      });
    } catch (err) {
      await recordTerminalCredentialFailure(err, run.orgId, runId, packageId);
      throw err;
    }
    logger.info("Integration credentials delivered", {
      runId,
      packageId,
      connectionId: bound.connectionId,
      authCount: result.auths.length,
      deliveryPlanCount: Object.keys(result.deliveryPlans).length,
    });
    return c.json(serializeIntegrationCredentialsWire(result));
  });

  // POST /internal/integration-credentials/:scope/:name/refresh
  // Sidecar-only, on an upstream 401: force-refreshes that connection's credential (200).
  // An auth with nothing to refresh (api_key, basic, unrefreshable OAuth) answers 502 below
  // the reconnect threshold and 410 once reached, or at once for a rejected MCP handshake
  // (`?rejected_request=handshake`); a revoked refresh token is 410 at once.
  // A 410 has flagged the connection `needsReconnection`, is stamped onto the run, and
  // tells the sidecar not to retry.
  router.post(`/integration-credentials/${SCOPED_PACKAGE_ROUTE}/refresh`, async (c) => {
    const packageId = `${c.req.param("scope")}/${c.req.param("name")}`;
    await refuseConnectRun(c, packageId);
    const { runId, run } = await verifyRunToken(c);
    await assertAgentDeclaresIntegration(packageId, run, runId);
    const bound = requireBoundConnection(c, packageId, run, runId);
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
          connectionId: bound.connectionId,
          connectionSource: bound.source,
          resolvedIntegrationVersions: run.resolvedIntegrationVersions,
        },
        {
          kind: "rejected",
          revision: credentialRevisionQuery(c) ?? null,
          handshake: rejectedHandshakeQuery(c),
        },
      );
    } catch (err) {
      // 410 = the connection was flagged needsReconnection (terminal). Record
      // it on the run so the run-detail banner can surface it, then re-throw so
      // the sidecar sees the 410 and stops retrying.
      await recordTerminalCredentialFailure(err, run.orgId, runId, packageId);
      throw err;
    }
    logger.info("Integration credentials refreshed", {
      runId,
      packageId,
      connectionId: bound.connectionId,
      authCount: result.auths.length,
    });
    return c.json(serializeIntegrationCredentialsWire(result));
  });

  // POST /internal/integration-calls
  // Sidecar-only. Attribution reads the run's FROZEN snapshot alone, never the live agent or the
  // space's activation, so a call that left stays journaled when the run's integrations change.
  router.post("/integration-calls", async (c) => {
    const { runId, run } = await verifyRunToken(c);
    const { calls } = await readJsonBody(c, integrationCallsBodySchema);
    const connectionIds = calls.map((call, i) => {
      if (call.connection_id === null) {
        if (run.resolvedIntegrationVersions?.[call.integration_id]) return null;
        logger.warn("integration calls refused — the run froze no such integration", {
          runId,
          integrationId: call.integration_id,
        });
        throw invalidRequest(
          `This run resolved no integration '${call.integration_id}'.`,
          `calls[${i}].integration_id`,
        );
      }
      return requireRunBoundMember({
        runId,
        packageId: call.integration_id,
        connectionId: call.connection_id.toLowerCase(),
        bound: run.resolvedConnections?.[call.integration_id] ?? [],
        param: `calls[${i}].connection_id`,
      }).connectionId;
    });
    const actor = actorFromIds(run.userId, run.endUserId);
    if (!actor) {
      logger.warn("integration calls not journaled — the run has no actor", {
        runId,
        records: calls.length,
      });
      return c.body(null, 204);
    }
    const requestId = c.get("requestId");
    // Off the response path, in one statement that keeps the batch's order.
    void trackAudit(
      recordConnectionCalls(
        calls.map((call, i) => ({
          orgId: run.orgId,
          spaceId: run.spaceId,
          connectionId: connectionIds[i] ?? null,
          integrationId: call.integration_id,
          actor,
          apiKeyId: run.apiKeyId,
          authMethod: RUN_SIDECAR_AUTH_METHOD,
          runId,
          chatSessionId: null,
          method: call.method,
          host: call.host,
          outcome: call.outcome,
          durationMs: call.duration_ms,
          requestId,
        })),
      ),
    );
    // A record carrying `credential_revision` ends its connection's rejection streak.
    for (const [i, call] of calls.entries()) {
      const connectionId = connectionIds[i];
      if (call.credential_revision === undefined || !connectionId) continue;
      await clearReachableUpstreamRejections(
        connectionId,
        call.integration_id,
        { spaceId: run.spaceId, actor },
        call.credential_revision,
      );
    }
    for (const [i, call] of calls.entries()) {
      const connectionId = connectionIds[i];
      if (call.required_scopes === undefined || !connectionId) continue;
      const standing = await recordRequestedScopes(
        connectionId,
        call.integration_id,
        { spaceId: run.spaceId, actor },
        call.required_scopes,
      );
      if (standing?.length) {
        await recordRunScopeRequest(run.orgId, runId, {
          integrationId: call.integration_id,
          connectionId,
          scopes: standing,
        });
      }
    }
    return c.body(null, 204);
  });

  // POST /internal/integration-credentials/:scope/:name/tools-observed
  // Sidecar-only: what a run's boot listed from a remote integration's server (the raw MCP
  // descriptors) and which selected tools it could not expose. Same run checks as the credentials GET.
  // The run's metadata always records the unavailable tools; the listing becomes the integration's
  // snapshot only for a platform-origin run (a remote-origin sidecar runs on the caller's
  // machine and is no authority on org state) and never for the platform's own endpoint integration.
  router.post(
    `/integration-credentials/${SCOPED_PACKAGE_ROUTE}/tools-observed`,
    bodyLimit(TOOLS_OBSERVED_MAX_BODY_BYTES),
    async (c) => {
      const packageId = `${c.req.param("scope")}/${c.req.param("name")}`;
      await refuseConnectRun(c, packageId);
      const { runId, run } = await verifyRunToken(c);
      await assertAgentDeclaresIntegration(packageId, run, runId);
      let connectionId: string | null = null;
      if (c.req.query("connection_id") !== undefined) {
        connectionId = requireBoundConnection(c, packageId, run, runId).connectionId;
      } else if ((run.resolvedConnections?.[packageId] ?? []).length > 0) {
        throw invalidRequest(
          `\`connection_id\` is required: this run bound connections to '${packageId}'.`,
          "connection_id",
        );
      }
      const body = await readJsonBody(c, toolsObservedSchema);
      await recordRunUnavailableTools(
        run.orgId,
        runId,
        body.unavailable.map((tool) => ({ integrationId: packageId, ...tool })),
      );
      if (
        body.tools !== undefined &&
        run.runOrigin === "platform" &&
        !listRuntimeBoundSystemIntegrationIds().includes(packageId)
      ) {
        const tools = body.tools.flatMap((tool) => {
          const parsed = observedToolSchema.safeParse(tool);
          return parsed.success ? [parsed.data] : [];
        });
        await recordToolSnapshot({
          orgId: run.orgId,
          packageId,
          connectionId,
          tools,
          truncated: body.truncated || tools.length < body.tools.length,
        }).catch((err: unknown) =>
          logger.warn("tools-observed: tool snapshot not recorded", {
            runId,
            packageId,
            error: getErrorMessage(err),
          }),
        );
      }
      return c.body(null, 204);
    },
  );

  // GET /internal/integration-bundle/:scope/:name[?version=]
  // Returns a LOCAL integration's own archive (manifest, INTEGRATION.md and the runnable server
  // payload `server.entry_point` is relative to); the sidecar fetches it before spawning a
  // runner. Authorised by the same Bearer run-token as the credentials surface; additionally
  // verifies the run's agent declares this integration, active in the run's space, and that it
  // is a local one — so a leaked run token can't enumerate arbitrary server source.
  //
  // WHICH bytes: the one version the run froze (`runs.resolved_integration_versions`). The
  // spawn spec names a published version in `server.version`, and `?version=` must equal it. A
  // system integration is served from the boot registry, and an integration the run froze on its
  // DRAFT (`dependency_overrides[id] = "draft"`) from the draft files; both carry no version, and
  // `?version=` is refused for them. A run with no frozen entry for the integration gets a 404.
  //
  // An ephemeral CONNECT run (`runAt: "link"` connect.tool login) reaches this endpoint too and
  // has no `runs` row and no agent to walk: it authorises against its launcher-published grant,
  // strictly narrower than the walk.
  router.get(`/integration-bundle/${SCOPED_PACKAGE_ROUTE}`, async (c) => {
    const integrationId = `${c.req.param("scope")}/${c.req.param("name")}`;
    const requestedVersion = c.req.query("version")?.trim() || undefined;
    const connect = await connectCallerOrNull(c);
    if (connect) {
      assertConnectGrantCoversIntegrationBundle(integrationId, requestedVersion, connect);
      return serveIntegrationBundle(integrationId, requestedVersion, connect.grant.orgId, {
        connectId: connect.connectId,
      });
    }
    const { runId, run } = await verifyRunToken(c);
    // Every launch path freezes each declared integration (`freezeRunSpawnDependencies`), so a
    // missing entry is not "serve the draft" — it is a run that never resolved this integration.
    const frozen = run.resolvedIntegrationVersions?.[integrationId];
    if (!frozen) {
      logger.warn("integration bundle request rejected — run froze no version for it", {
        runId,
        integrationId,
      });
      throw notFound(`Run has no resolved version for '${integrationId}'`);
    }
    await assertAgentDeclaresLocalIntegration(integrationId, run, runId, frozen);
    assertBundleVersionPermitted(
      integrationId,
      frozen.source === "version" ? frozen.version : null,
      requestedVersion,
      { runId },
    );
    return serveIntegrationBundle(integrationId, requestedVersion, run.orgId, { runId });
  });

  /**
   * Deliver an integration's archive. The "who may read what" decision has ALREADY happened
   * (`assertAgentDeclaresLocalIntegration` for a run token, the grant check for a connect token,
   * and `assertBundleVersionPermitted` for both), so the two callers cannot drift on version
   * pinning. `orgId` is the tenant scope: the version lookup binds it, and the draft's storage
   * key carries it.
   */
  async function serveIntegrationBundle(
    integrationId: string,
    version: string | undefined,
    orgId: string,
    caller: { runId: string } | { connectId: string },
  ): Promise<Response> {
    const sys = getSystemPackages().get(integrationId);
    if (sys?.zipBuffer) {
      logger.info("integration bundle delivered (system)", {
        ...caller,
        integrationId,
        bytes: sys.zipBuffer.length,
      });
      return new Response(Buffer.from(sys.zipBuffer), {
        status: 200,
        headers: { "Content-Type": "application/zip" },
      });
    }
    // No version: the run froze the draft (or a connect run found nothing published). The draft's
    // files are read at fetch time, so a draft edited after launch is served as edited.
    if (!version) return serveDraftIntegrationBundle(integrationId, orgId, caller);
    // Tenant scope on the VERSION lookup itself, the technique `resolvePublishedManifest` uses
    // on the same two tables: a pre-check on `packages` followed by an unfiltered version read
    // would be the TOCTOU this avoids.
    const [resolved] = await db
      .select({ version: packageVersions.version, integrity: packageVersions.integrity })
      .from(packageVersions)
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .where(
        and(
          eq(packageVersions.packageId, integrationId),
          eq(packageVersions.version, version),
          orgOrSystemFilter(orgId),
        ),
      )
      .limit(1);
    if (!resolved) {
      throw notFound(`Version '${version}' not found for '${integrationId}'`);
    }
    const bytes = await downloadVersionZipForExecution(
      integrationId,
      resolved.version,
      resolved.integrity,
    );
    if (!bytes) throw notFound(`Bundle bytes unavailable for '${integrationId}'`);
    logger.info("integration bundle delivered (storage)", {
      ...caller,
      integrationId,
      version: resolved.version,
      bytes: bytes.length,
    });
    return new Response(bytes, { status: 200, headers: { "Content-Type": "application/zip" } });
  }

  /** The draft files of an integration the org owns, zipped like a published archive. */
  async function serveDraftIntegrationBundle(
    integrationId: string,
    orgId: string,
    caller: { runId: string } | { connectId: string },
  ): Promise<Response> {
    const [row] = await db
      .select({
        id: packages.id,
        type: packages.type,
        orgId: packages.orgId,
        draftManifest: packages.draftManifest,
        draftContent: packages.draftContent,
      })
      .from(packages)
      .where(
        and(
          eq(packages.id, integrationId),
          eq(packages.type, "integration"),
          eq(packages.orgId, orgId),
        ),
      )
      .limit(1);
    if (!row) throw notFound(`Draft files unavailable for '${integrationId}'`);
    // The explorer's reader, so the archive carries the same DB-authoritative `manifest.json`
    // overlay every other draft reader sees — the one the spawn spec was built from.
    const { files } = await readPackageSnapshot(row, {
      kind: "draft",
      snapshotId: null,
      yanked: false,
    });
    const bytes = zipArtifact(files, 6);
    logger.info("integration bundle delivered (draft)", {
      ...caller,
      integrationId,
      bytes: bytes.length,
    });
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: { "Content-Type": "application/zip" },
    });
  }

  /**
   * {@link assertAgentDeclaresIntegration}, plus: the integration, read at the version the run
   * froze, must be a LOCAL one with a server to run. Any other source has no archive to serve.
   */
  async function assertAgentDeclaresLocalIntegration(
    integrationId: string,
    run: { packageId: string; orgId: string; spaceId: string; versionRef: string | null },
    runId: string,
    frozen: ResolvedIntegrationVersionMap[string],
  ): Promise<void> {
    await assertAgentDeclaresIntegration(integrationId, run, runId);
    const res = await readIntegrationManifestForRun(integrationId, frozen);
    if (!res.ok || !getLocalServer(res.manifest)) {
      logger.warn("integration bundle request rejected — not a local integration", {
        runId,
        integrationId,
      });
      throw notFound(`Integration '${integrationId}' is not a local integration with a server`);
    }
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
 * the running agent" / "not active", so reusing it for a deleted agent
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
 *   1. Per-run pinning (fail-closed): the requested credentialId MUST equal
 *      the run's launch credential (`runs.model_credential_id`). A run with
 *      a NULL pin (a built-in model or an alias) has NO legitimate reason to
 *      read ANY credential, so it is rejected outright — a leaked run token
 *      from such a run must not be able to enumerate the org's credentials.
 *   2. Org-membership: the credential row exists and `orgId === run.orgId`.
 *   3. Owner: a personal credential (`owner_user_id` set) serves only the run
 *      whose recorded payer (`runs.payer_user_id`) is its owner, and nothing
 *      while the organization has personal credentials off. An organization
 *      credential serves every run of the organization.
 *   4. UUID well-formedness: malformed path params surface as 404 not 500.
 *
 * Remote-origin runs (where the pin is structurally absent) are already
 * rejected upstream by `assertPlatformOriginOAuthAccess`; the null-pin
 * rejection here makes the surface fail-closed even without that guard.
 */
type VerifiedRun = Awaited<ReturnType<typeof verifyRunToken>>["run"];

async function assertOAuthModelCredential(credentialId: string, run: VerifiedRun): Promise<void> {
  // Fail closed: no pin ⇒ no OAuth credential access, ever. Narrowing the
  // pin to a non-null string HERE (instead of an `!== null &&` short-circuit
  // that silently skips the equality gate) means the lookup below can only
  // ever be keyed by the run's own pinned credential.
  if (run.modelCredentialId === null) {
    throw forbidden("Run has no OAuth model provider credential pinned");
  }
  const pinned: string = run.modelCredentialId;
  if (pinned !== credentialId) {
    throw forbidden(`Credential ${credentialId} not pinned to this run`);
  }
  let row: { orgId: string; ownerUserId: string | null } | undefined;
  try {
    [row] = await db
      .select({
        orgId: modelProviderCredentials.orgId,
        ownerUserId: modelProviderCredentials.ownerUserId,
      })
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
  if (row.orgId !== run.orgId) {
    throw forbidden(`Credential ${credentialId} not in run org`);
  }
  // One rule for the door: the run's recorded payer is the only member a personal
  // credential may serve. An API-key run records no payer, so it never matches.
  if (row.ownerUserId !== null && row.ownerUserId !== run.payerUserId) {
    throw forbidden(`Credential ${credentialId} is another member's`);
  }
  if (row.ownerUserId !== null && !(await personalModelCredentialsAllowed(run.orgId))) {
    throw personalModelCredentialsDisabled();
  }
}
