// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Desktop bridge routes — full paths, mounted at root by the module
 * loader.
 *
 *   - `GET  /api/desktop/bridge` — WebSocket upgrade. The desktop app
 *     connects with the Better Auth session cookie of the webapp pane
 *     it embeds; the standard auth middleware resolves the user before
 *     this handler runs, and that user is what we register.
 *   - `GET  /api/desktop/me/status` — is the caller's desktop connected.
 *   - `POST /api/desktop/me/command` — drive one's own desktop (smoke
 *     tests, CLI). Not on the agent execution path; no substitution.
 *   - `POST /internal/desktop-command` — sidecar-only, backs the
 *     `desktop_browser` runtime tool. Run-token auth. Supports
 *     credential substitution: `integration_id` + `substitute_params`
 *     resolve the run's connected credentials for that integration and
 *     replace `{{field}}` placeholders inside `params` server-side, so
 *     secret values never enter the agent's context. Every reply for a
 *     run that used substitution is scrubbed of the substituted values
 *     (see `secret-scrub.ts`).
 *
 * The `/api/desktop/*` routes are user-scoped and org-agnostic: a
 * desktop belongs to a person, not to an organization. They are
 * whitelisted in core `skipOrgContext` (`lib/auth-pipeline.ts`) — a
 * path-based allowance that is harmless when this module is disabled
 * (the paths then 404 at the catch-all).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../types/index.ts";
import { logger } from "../../lib/logger.ts";
import { getEnv } from "@appstrate/env";
import { asRecord } from "@appstrate/core/safe-json";
import {
  ApiError,
  unauthorized,
  forbidden,
  notFound,
  invalidRequest,
  badGateway,
  serviceUnavailable,
  internalError,
  conflict,
  parseBody,
} from "../../lib/errors.ts";
import { upgradeWebSocket } from "../../lib/websocket.ts";
import { rateLimit, rateLimitByBearer } from "../../middleware/rate-limit.ts";
import { verifyRunToken } from "../../routes/internal.ts";
import { getPackage } from "../../services/package-catalog.ts";
import { actorFromIds } from "../../lib/actor.ts";
import { resolveLiveIntegrationCredentials } from "../../services/integration-credentials-resolver.ts";
import { readIntegrationManifestForRun } from "../../services/integration-service.ts";
import { matchesAuthorizedUriSpec } from "@appstrate/afps-runtime/resolvers";
import { setRunEphemeralCredentials } from "../../services/run-ephemeral-credentials.ts";
import {
  registerClient,
  unregisterClient,
  sendCommand,
  handleClientFrame,
  DesktopNotConnectedError,
  DesktopCommandError,
  DesktopCommandTimeoutError,
  isConnected,
} from "./registry.ts";
import { registerRunSecrets, scrubRunSecrets } from "./secret-scrub.ts";
import {
  acquireDesktopOriginLease,
  awaitHumanHandoff,
  assertTabBudget,
  forgetDesktopTab,
  listDesktopTabsForRun,
  noteDesktopTabOrigin,
  recordDesktopExposure,
  registerDesktopTab,
  requireDesktopTab,
  setDesktopTabPaused,
  DesktopLeaseConflictError,
  DesktopExposureConflictError,
  DesktopTabGoneError,
  DesktopTabPausedError,
  DesktopTabQuotaError,
} from "./lease.ts";
import {
  createDownload,
  getDownloadForRun,
  toStatusPayload,
  DOWNLOADS_BUCKET,
} from "./downloads.ts";
import { downloadStream as storageDownloadStream } from "@appstrate/db/storage";
import {
  DESKTOP_BRIDGE_MAX_FRAME_BYTES,
  DESKTOP_BRIDGE_PROTOCOL_VERSION,
  DESKTOP_BRIDGE_SUPPORTED_PROTOCOLS,
} from "./protocol.ts";

/**
 * Translate a registry rejection into the platform's RFC 9457 error
 * shape. Timeout gets a 504 (the desktop is connected but silent),
 * absence a 503, an error reported by the desktop itself a 502.
 *
 * `scrub` cleans desktop-reported error messages: a page script that
 * throws with the just-filled value in its message must not carry that
 * value back into the agent's context.
 */
export function desktopErrorToApiError(err: unknown, scrub?: (text: string) => string): ApiError {
  if (err instanceof DesktopLeaseConflictError) {
    return conflict(
      "desktop_in_use",
      "This browser surface is already controlled by another active run",
    );
  }
  if (err instanceof DesktopTabPausedError) {
    return conflict(
      "desktop_tab_paused",
      `${err.message} — it stays yours, but you cannot drive it until they hand it back`,
    );
  }
  if (err instanceof DesktopTabQuotaError) {
    return conflict("desktop_tab_quota", err.message);
  }
  if (err instanceof DesktopTabGoneError) {
    return new ApiError({
      status: 410,
      code: "desktop_tab_gone",
      title: "Gone",
      detail: `${err.message} — open a new tab with browser.tabs.open`,
    });
  }
  if (err instanceof DesktopExposureConflictError) {
    return conflict("desktop_secret_boundary", err.message);
  }
  if (err instanceof DesktopNotConnectedError) {
    return serviceUnavailable("No Appstrate Desktop connected for this user");
  }
  if (err instanceof DesktopCommandTimeoutError) {
    return new ApiError({
      status: 504,
      code: "desktop_command_timeout",
      title: "Gateway Timeout",
      detail: err.message,
    });
  }
  if (err instanceof DesktopCommandError) {
    return badGateway(scrub ? scrub(err.message) : err.message);
  }
  return err instanceof ApiError ? err : internalError();
}

/**
 * Reject a cookie-authenticated WebSocket upgrade coming from a page we
 * don't trust — the WebSocket equivalent of CSRF (CSWSH).
 *
 * The handshake is a plain GET that the browser sends with the user's
 * cookies, and neither CORS nor the SPA's CSRF story applies to it. A
 * page on evil.test could therefore open `ws://<instance>/api/desktop/bridge`
 * in a logged-in victim's browser and be registered as *their* desktop:
 * the registry displaces the real client, so the attacker both cuts the
 * user off and receives every command the platform dispatches to them.
 *
 * Two-part rule, matching who legitimately connects:
 *   - Origin present → it is a browser (the header is browser-controlled
 *     and unforgeable from script), so it must be a trusted origin.
 *   - Origin absent → a native client (the Electron bridge sends only
 *     `Cookie`, per `apps/desktop/src/bridge/client.ts`). Nothing to
 *     check: the attack this guards against is browser-borne, and a
 *     non-browser attacker able to set arbitrary headers would need the
 *     session cookie anyway.
 *
 * `SameSite=lax` on the session cookie already stops modern browsers
 * from attaching it here (a WS handshake is not a top-level navigation).
 * This is the belt to that suspenders — cheap, and the failure mode it
 * covers is a silent session takeover.
 */
export function isTrustedUpgradeOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  const env = getEnv();
  const allowed = [...env.TRUSTED_ORIGINS, env.APP_URL];
  return allowed.some((candidate) => {
    try {
      return new URL(candidate).origin === new URL(origin).origin;
    } catch {
      return false;
    }
  });
}

/**
 * Replace `{{field}}` placeholders in every string of `value` with the
 * matching credential field. Unknown placeholders are left intact
 * (spec-correct fail-safe — a typo'd key surfaces as a literal
 * `{{typo}}` in the page instead of silently becoming ""). Walks own
 * enumerable string-keyed properties and rebuilds plain objects.
 */
const PLACEHOLDER = /\{\{([\w.-]+)\}\}/g;

export function substituteInValue(value: unknown, fields: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER, (match, key: string) =>
      key in fields ? fields[key]! : match,
    );
  }
  if (Array.isArray(value)) return value.map((v) => substituteInValue(v, fields));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteInValue(v, fields);
    return out;
  }
  return value;
}

type RunContext = Awaited<ReturnType<typeof verifyRunToken>>["run"];

/**
 * Session modes, declared as `desktop_browser.session` in the agent
 * manifest. They decide WHICH Chromium profile the agent's tabs live in,
 * which is what decides who can read the sessions it opens.
 *
 *   isolated — a throwaway profile per run. Nothing survives it.
 *   agent    — one persistent profile per agent (the default). Sessions
 *              are reused across ITS runs, and are unreadable by any
 *              other agent.
 *   user     — the human's own browser profile. Opt-in, for the hybrid
 *              cases where a login cannot be automated at all.
 *
 * Default matters: v1 put every run in the user's profile, so a session
 * one agent opened stayed available to the next one. `agent` keeps the
 * convenience (no re-login every run) without the shared pot.
 */
export type DesktopSessionMode = "isolated" | "agent" | "user";

/**
 * Sentinel for the user's own browser profile. The desktop resolves it
 * against its active instance profile; the platform never learns the
 * concrete partition name, and every `user`-mode agent maps to the same
 * key, which is what makes the origin lease serialize them.
 */
export const USER_PARTITION_SPEC = "@user";

function partitionSpec(mode: DesktopSessionMode, packageId: string, runId: string): string {
  if (mode === "user") return USER_PARTITION_SPEC;
  if (mode === "isolated") return `appstrate-run-${runId}`;
  // `@scope/name` → a filesystem-safe, collision-free profile key.
  return `persist:appstrate-agent-${packageId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

interface RunDesktopPolicy {
  runtimeTools: ReadonlySet<string>;
  integrations: ReadonlySet<string>;
  authorizedUris: readonly string[];
  sessionMode: DesktopSessionMode;
  partition: string;
  touchedAt: number;
}

const POLICY_RETENTION_MS = 6 * 60 * 60 * 1000;
const policyByRun = new Map<string, RunDesktopPolicy>();

async function loadRunDesktopPolicy(run: RunContext, runId: string): Promise<RunDesktopPolicy> {
  const cached = policyByRun.get(runId);
  if (cached) {
    cached.touchedAt = Date.now();
    return cached;
  }
  const agent = await getPackage(run.packageId, run.orgId, { includeEphemeral: true });
  if (!agent) throw notFound("Agent not found");
  const manifest = asRecord(agent.manifest);
  const runtimeToolsRaw = manifest.runtime_tools;
  const integrations = asRecord(asRecord(manifest.dependencies).integrations);
  const desktopBrowser = asRecord(manifest.desktop_browser);
  const authorizedUrisRaw = desktopBrowser.authorized_uris;
  const sessionRaw = desktopBrowser.session;
  const sessionMode: DesktopSessionMode =
    sessionRaw === "isolated" || sessionRaw === "user" ? sessionRaw : "agent";
  const policy: RunDesktopPolicy = {
    runtimeTools: new Set(
      Array.isArray(runtimeToolsRaw)
        ? runtimeToolsRaw.filter((value): value is string => typeof value === "string")
        : [],
    ),
    integrations: new Set(Object.keys(integrations)),
    authorizedUris: Array.isArray(authorizedUrisRaw)
      ? authorizedUrisRaw.filter((value): value is string => typeof value === "string")
      : [],
    sessionMode,
    partition: partitionSpec(sessionMode, run.packageId, runId),
    touchedAt: Date.now(),
  };
  policyByRun.set(runId, policy);
  const now = Date.now();
  for (const [id, entry] of policyByRun) {
    if (now - entry.touchedAt > POLICY_RETENTION_MS) policyByRun.delete(id);
  }
  return policy;
}

export function clearRunDesktopPolicy(runId?: string): void {
  if (runId === undefined) {
    policyByRun.clear();
    return;
  }
  policyByRun.delete(runId);
}

async function assertDesktopCapability(
  run: RunContext,
  runId: string,
  method: string,
  steps?: Array<{ method?: string }>,
): Promise<RunDesktopPolicy> {
  const policy = await loadRunDesktopPolicy(run, runId);
  if (!policy.runtimeTools.has("desktop_browser") || policy.authorizedUris.length === 0) {
    throw forbidden(
      "This agent did not declare desktop_browser with a non-empty authorized_uris boundary",
    );
  }
  const usesEvaluate =
    method === "browser.evaluate" ||
    steps?.some((step) => step?.method === "browser.evaluate") === true;
  if (usesEvaluate && !policy.runtimeTools.has("desktop_browser_evaluate")) {
    throw forbidden("browser.evaluate requires the desktop_browser_evaluate capability");
  }
  return policy;
}

function assertAuthorizedTarget(
  policy: RunDesktopPolicy,
  target: unknown,
  param = "params.url",
): void {
  if (
    typeof target !== "string" ||
    !policy.authorizedUris.some((spec) => matchesAuthorizedUriSpec(spec, target))
  ) {
    throw forbidden(`Desktop target is outside the agent's authorized_uris boundary: ${param}`);
  }
}

/**
 * Same fail-closed gate as the core `/internal/integration-credentials`
 * endpoints (`routes/internal.ts`): the running agent must DECLARE the
 * integration as a dependency before its run token can touch that
 * integration's credentials. A leaked run token must not be able to
 * substitute (and then exfiltrate via the page) arbitrary secrets
 * across the org.
 */
async function assertAgentDeclaresIntegration(
  integrationId: string,
  run: RunContext,
  runId: string,
): Promise<void> {
  const policy = await loadRunDesktopPolicy(run, runId);
  if (!policy.integrations.has(integrationId)) {
    logger.warn("Desktop substitution rejected — integration not declared by agent", {
      runId,
      integrationId,
      agentId: run.packageId,
      module: "desktop",
    });
    throw notFound(`Integration '${integrationId}' is not a dependency of the running agent`);
  }
}

/**
 * Zod source of truth for the command bodies — registered against the
 * spec through the module's `openApiSchemas()` contribution so the
 * Zod↔OpenAPI comparison gate (`verify:openapi` step 4) locks the two
 * together. Wire casing per docs/CASING_CONVENTIONS.md: compound field
 * names are snake_case (`integration_id` is integration-domain wire,
 * not one of the universal camelCase carve-outs).
 */
/**
 * Step methods a batch may carry — the desktop-executable verbs.
 * Excludes `browser.batch` (no nesting) and `browser.download_status`
 * (answered platform-side; polling inside a fire-and-forget sequence
 * would be meaningless).
 */
const BATCHABLE_METHODS = new Set([
  "browser.navigate",
  "browser.click",
  "browser.fill",
  "browser.selectOption",
  "browser.evaluate",
  "browser.screenshot",
  "browser.waitForSelector",
  "browser.download",
]);
const BATCH_MAX_STEPS = 40;

/**
 * Methods whose params may carry `{{field}}` credential substitution.
 * The scrubber protects the RETURN path; this allowlist closes the
 * OUTBOUND one: substituting into `browser.navigate`'s url (or a
 * download url) would ship the secret to an attacker-chosen server in
 * the request line itself. Substituted values must stay local to the
 * user's machine: a DOM field written by the trusted `fill` primitive.
 * Arbitrary `evaluate` scripts are deliberately excluded: a script can
 * transform a secret before returning it or send it over the network,
 * neither of which exact-value reply scrubbing can prevent.
 */
const SUBSTITUTABLE_METHODS = new Set(["browser.fill"]);

type CaptureSource = {
  source: "local_storage" | "session_storage" | "cookie";
  key: string;
  json_path?: Array<string | number>;
};

interface IntegrationCapturePolicy {
  authorizedUris: string[];
  credentialFields: ReadonlySet<string>;
}

/**
 * Load the exact auth selected for capture. The source URL and output
 * field names are both bound to that auth rather than to a union across
 * the integration.
 */
async function loadIntegrationCapturePolicy(
  integrationId: string,
  authKey: string,
  run: RunContext,
): Promise<IntegrationCapturePolicy | null> {
  const frozen = run.resolvedIntegrationVersions?.[integrationId] ?? null;
  const loaded = await readIntegrationManifestForRun(integrationId, frozen);
  if (!loaded.ok) return null;
  const auths = asRecord(asRecord(loaded.manifest).auths);
  const auth = asRecord(auths[authKey]);
  if (Object.keys(auth).length === 0) return null;
  const authorizedUrisRaw = auth.authorized_uris;
  const properties = asRecord(asRecord(asRecord(auth.credentials).schema).properties);
  return {
    authorizedUris: Array.isArray(authorizedUrisRaw)
      ? authorizedUrisRaw.filter((value): value is string => typeof value === "string")
      : [],
    credentialFields: new Set(Object.keys(properties)),
  };
}

async function captureCredential(
  c: Context<AppEnv>,
  run: RunContext,
  runId: string,
  body: { params?: unknown; timeout_ms?: number },
  tabId: string,
): Promise<Response> {
  if (!run.userId) {
    throw forbidden("capture_credential requires a user-owned run");
  }
  const p = (body.params ?? {}) as {
    integration_id?: string;
    auth_key?: string;
    fields?: Record<string, CaptureSource>;
  };
  if (!p.integration_id || !p.auth_key || !p.fields) {
    throw invalidRequest("capture_credential needs integration_id, auth_key and fields", "params");
  }
  await assertAgentDeclaresIntegration(p.integration_id, run, runId);

  const capturePolicy = await loadIntegrationCapturePolicy(p.integration_id, p.auth_key, run);
  if (!capturePolicy) {
    throw notFound(`Unknown auth '${p.auth_key}' for integration '${p.integration_id}'`);
  }
  const sourceEntries = Object.entries(p.fields);
  if (sourceEntries.length === 0 || sourceEntries.length > 16) {
    throw invalidRequest("capture_credential fields must contain 1 to 16 entries", "params.fields");
  }
  for (const [field, source] of sourceEntries) {
    if (!capturePolicy.credentialFields.has(field)) {
      throw invalidRequest(
        `Field '${field}' is not declared by auth '${p.auth_key}' credentials.schema`,
        "params.fields",
      );
    }
    if (
      !source ||
      !["local_storage", "session_storage", "cookie"].includes(source.source) ||
      typeof source.key !== "string" ||
      source.key.length === 0 ||
      source.key.length > 256 ||
      (source.json_path !== undefined &&
        (!Array.isArray(source.json_path) ||
          source.json_path.length > 8 ||
          source.json_path.some(
            (part) =>
              (typeof part !== "string" && typeof part !== "number") ||
              (typeof part === "string" && part.length > 128),
          )))
    ) {
      throw invalidRequest(`Invalid declarative source for field '${field}'`, "params.fields");
    }
  }

  // Electron evaluates only a fixed storage reader. The agent supplies
  // data selectors, never executable JavaScript.
  let raw: unknown;
  try {
    raw = await sendCommand(
      run.userId,
      "browser.capture",
      { fields: p.fields },
      {
        timeoutMs: body.timeout_ms,
        authorizedUris: capturePolicy.authorizedUris,
        tabId,
        runId,
      },
    );
  } catch (err) {
    throw desktopErrorToApiError(err);
  }
  const envelope = raw as { url?: unknown; fields?: unknown };
  const pageUrl = typeof envelope?.url === "string" ? envelope.url : "";
  if (
    !pageUrl ||
    !capturePolicy.authorizedUris.some((spec) => matchesAuthorizedUriSpec(spec, pageUrl))
  ) {
    logger.warn("Desktop capture rejected — page outside the integration's authorized_uris", {
      runId,
      integrationId: p.integration_id,
      module: "desktop",
    });
    throw forbidden(
      `capture_credential: the current page is not within '${p.integration_id}' authorized_uris — ` +
        `you can only capture a site's secret while browsing that site`,
    );
  }
  const captured = envelope.fields;
  if (!captured || typeof captured !== "object" || Array.isArray(captured)) {
    throw badGateway("desktop capture must return an object of { field: value } string pairs");
  }
  const credentials: Record<string, string> = {};
  let totalBytes = 0;
  for (const [k, v] of Object.entries(captured as Record<string, unknown>)) {
    if (!capturePolicy.credentialFields.has(k) || !(k in p.fields)) continue;
    if (typeof v !== "string" || v.length === 0) continue;
    const bytes = Buffer.byteLength(v);
    if (bytes > 64 * 1024) {
      throw badGateway(`captured field '${k}' exceeds the 64 KiB limit`);
    }
    totalBytes += bytes;
    if (totalBytes > 256 * 1024) {
      throw badGateway("captured credential exceeds the 256 KiB total limit");
    }
    credentials[k] = v;
  }
  if (Object.keys(credentials).length === 0) {
    throw badGateway("desktop capture returned no non-empty string fields");
  }

  // Write to the RUN-SCOPED ephemeral store, NOT the durable connection.
  // A browser-captured session token is short-lived and re-acquired
  // every run; persisting it drags in the reconnection lifecycle (a 401
  // flags needsReconnection → the next kickoff blocks → deadlock) and
  // the one-connection cascade. Run-scoped, it merges over the durable
  // login connection at injection time and evaporates with the run:
  // no persistence, no reconnection, no kickoff block, no stale cache.
  setRunEphemeralCredentials(runId, p.integration_id, p.auth_key, credentials);
  // Belt: if any captured value later echoes in a desktop reply, redact it.
  registerRunSecrets(runId, Object.values(credentials));
  logger.info("Desktop credential captured", {
    runId,
    integrationId: p.integration_id,
    authKey: p.auth_key,
    fieldCount: Object.keys(credentials).length,
    module: "desktop",
  });
  return c.json({ result: { captured: true, fields: Object.keys(credentials) } });
}

/**
 * Resolve the run actor's connected credential fields for an
 * integration, gated by the same fail-closed check as
 * `/internal/integration-credentials` (the agent must declare it), and
 * register the values for reply-scrubbing. Shared by the single-command
 * and batch substitution paths so the gate and the scrub-registration
 * can't drift between them.
 */
async function resolveSubstitutionFields(
  integrationId: string | undefined,
  run: RunContext,
  runId: string,
): Promise<Record<string, string>> {
  if (!integrationId) {
    throw invalidRequest(
      "`integration_id` is required when `substitute_params` is set",
      "integration_id",
    );
  }
  await assertAgentDeclaresIntegration(integrationId, run, runId);
  const wire = await resolveLiveIntegrationCredentials(integrationId, {
    runId,
    orgId: run.orgId,
    applicationId: run.applicationId,
    agentPackageId: run.packageId,
    actor: actorFromIds(run.userId, run.endUserId),
    resolvedConnections: run.resolvedConnections,
    resolvedIntegrationVersions: run.resolvedIntegrationVersions,
  });
  const fields: Record<string, string> = {};
  for (const auth of wire.auths) Object.assign(fields, auth.fields);
  if (Object.keys(fields).length === 0) {
    throw notFound(`No credentials available for integration '${integrationId}'`);
  }
  registerRunSecrets(runId, Object.values(fields));
  return fields;
}

/**
 * Open a tab for a run and record the lease. The partition comes from
 * the agent's declared session mode — the desktop never picks it, which
 * is what keeps one agent's profile out of another's.
 */
async function openRunTab(
  run: RunContext,
  runId: string,
  policy: RunDesktopPolicy,
  timeoutMs?: number,
): Promise<string> {
  const userId = run.userId!;
  assertTabBudget(userId, runId);
  const raw = await sendCommand(
    userId,
    "tabs.open",
    { partition: policy.partition, agent_name: run.packageId, background: true },
    {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      authorizedUris: policy.authorizedUris,
      runId,
    },
  );
  const tabId = (raw as { tab_id?: unknown } | undefined)?.tab_id;
  if (typeof tabId !== "string" || tabId.length === 0) {
    throw badGateway("desktop did not return a tab id");
  }
  registerDesktopTab(userId, runId, tabId, policy.partition);
  logger.info("Desktop tab opened", {
    runId,
    tabId,
    partition: policy.partition,
    sessionMode: policy.sessionMode,
    module: "desktop",
  });
  return tabId;
}

/**
 * Resolve which tab a command drives.
 *
 * An explicit `tab_id` is validated against the run's leases. Without
 * one, the run gets its IMPLICIT tab: the first it owns, or a freshly
 * opened one. That fallback is what lets every pre-tabs agent keep
 * working with no manifest change — it simply never names a tab.
 */
async function resolveRunTab(
  run: RunContext,
  runId: string,
  policy: RunDesktopPolicy,
  requested: string | undefined,
  timeoutMs?: number,
): Promise<string> {
  const userId = run.userId!;
  if (requested) {
    requireDesktopTab(userId, runId, requested);
    return requested;
  }
  const owned = listDesktopTabsForRun(runId).filter((entry) => entry.userId === userId);
  if (owned.length > 0) {
    const tabId = owned[0]!.tabId;
    requireDesktopTab(userId, runId, tabId);
    return tabId;
  }
  return openRunTab(run, runId, policy, timeoutMs);
}

/** `browser.tabs.*` — tab lifecycle, answered platform-side. */
async function handleTabsCommand(
  c: Context<AppEnv>,
  run: RunContext,
  runId: string,
  policy: RunDesktopPolicy,
  body: { method: string; tab_id?: string; timeout_ms?: number },
): Promise<Response> {
  const userId = run.userId!;
  if (body.method === "browser.tabs.open") {
    const tabId = await openRunTab(run, runId, policy, body.timeout_ms);
    return c.json({ result: { tab_id: tabId } });
  }
  if (body.method === "browser.tabs.list") {
    // Only this run's tabs: the desktop hosts other runs' surfaces and
    // the user's own, and neither is any of this agent's business.
    return c.json({
      result: {
        tabs: listDesktopTabsForRun(runId)
          .filter((entry) => entry.userId === userId)
          .map((entry) => ({ tab_id: entry.tabId })),
      },
    });
  }
  if (!body.tab_id) {
    throw invalidRequest("`tab_id` is required to close a tab", "tab_id");
  }
  requireDesktopTab(userId, runId, body.tab_id);
  await sendCommand(
    userId,
    "tabs.close",
    { tab_id: body.tab_id },
    { ...(body.timeout_ms !== undefined ? { timeoutMs: body.timeout_ms } : {}), runId },
  );
  forgetDesktopTab(userId, body.tab_id);
  return c.json({ result: { closed: true } });
}

const DIRECT_BROWSER_METHODS = [
  "browser.navigate",
  "browser.click",
  "browser.fill",
  "browser.selectOption",
  "browser.evaluate",
  "browser.screenshot",
  "browser.waitForSelector",
] as const;

const AGENT_BROWSER_METHODS = [
  ...DIRECT_BROWSER_METHODS,
  "browser.download",
  "browser.download_status",
  "browser.capture_credential",
  "browser.batch",
  "browser.tabs.open",
  "browser.tabs.close",
  "browser.tabs.list",
  "browser.request_human",
] as const;

const TAB_LIFECYCLE_METHODS = new Set<string>([
  "browser.tabs.open",
  "browser.tabs.close",
  "browser.tabs.list",
]);

/**
 * How long one `browser.request_human` call parks the run. Kept under
 * the platform's own request ceilings; a person who needs longer just
 * makes the agent ask again, and the tab stays parked in between.
 */
const HUMAN_HANDOFF_TIMEOUT_MS = 110_000;

const commandFields = {
  params: z.record(z.string(), z.unknown()).optional(),
  timeout_ms: z.number().int().min(1000).max(120000).optional(),
};

export const desktopCommandSchema = z.object({
  method: z.enum(DIRECT_BROWSER_METHODS),
  ...commandFields,
});

export const desktopAgentCommandSchema = z.object({
  method: z.enum(AGENT_BROWSER_METHODS),
  ...commandFields,
  integration_id: z.string().optional(),
  substitute_params: z.boolean().optional(),
  tab_id: z.string().optional(),
});

async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw invalidRequest("Invalid JSON body");
  }
}

function boundedDownloadStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  expectedBytes: number | null,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (expectedBytes !== null && seen !== expectedBytes) {
            controller.error(new Error("stored download size does not match desktop metadata"));
          } else {
            controller.close();
          }
          return;
        }
        seen += value.byteLength;
        if (seen > maxBytes) {
          await reader.cancel("download exceeded signed size ceiling");
          controller.error(new Error("stored download exceeds signed size ceiling"));
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export function createDesktopRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get(
    "/api/desktop/bridge",
    async (c, next) => {
      const origin = c.req.header("Origin");
      if (!isTrustedUpgradeOrigin(origin)) {
        logger.warn("Desktop bridge: rejected upgrade from untrusted origin", {
          module: "desktop",
          origin,
        });
        throw forbidden("Origin not allowed for the desktop bridge");
      }
      const protocol = c.req.query("protocol") ?? "";
      if (!(DESKTOP_BRIDGE_SUPPORTED_PROTOCOLS as readonly string[]).includes(protocol)) {
        throw new ApiError({
          status: 426,
          code: "desktop_protocol_mismatch",
          title: "Upgrade Required",
          detail: `Desktop bridge protocol ${DESKTOP_BRIDGE_PROTOCOL_VERSION} is required (accepted: ${DESKTOP_BRIDGE_SUPPORTED_PROTOCOLS.join(", ")})`,
        });
      }
      await next();
    },
    upgradeWebSocket((c) => {
      // Auth has already run via the platform middleware chain — if
      // `user` is missing we wouldn't be here. Capture the id now so the
      // callbacks below can register / unregister without re-reading `c`
      // (the context object's lifetime ends at upgrade time).
      const userId = c.get("user")?.id;
      if (!userId) {
        // Defense in depth — the auth middleware rejects unauthenticated
        // upgrades long before we reach this point.
        return { onMessage: (): void => {} };
      }
      let registered: { userId: string; send(payload: string): void; close(): void } | null = null;

      return {
        onOpen: (_evt, ws): void => {
          registered = {
            userId,
            send: (payload): void => ws.send(payload),
            close: (): void => ws.close(),
          };
          registerClient(registered);
        },
        onMessage: (evt, ws): void => {
          let parsed: { id?: string; method?: string; result?: unknown };
          try {
            const raw = typeof evt.data === "string" ? evt.data : evt.data.toString();
            if (Buffer.byteLength(raw) > DESKTOP_BRIDGE_MAX_FRAME_BYTES) {
              ws.close(1009, "desktop bridge frame too large");
              return;
            }
            parsed = JSON.parse(raw);
          } catch {
            logger.debug("Desktop bridge: dropped malformed message", { module: "desktop" });
            return;
          }
          handleClientFrame(userId, parsed);
        },
        onClose: (): void => {
          if (registered) unregisterClient(userId, registered);
        },
        onError: (): void => {
          if (registered) unregisterClient(userId, registered);
        },
      };
    }),
  );

  router.get("/api/desktop/me/status", (c) => {
    const user = c.get("user");
    if (!user) throw unauthorized("Authentication required");
    return c.json({ connected: isConnected(user.id) });
  });

  router.post("/api/desktop/me/command", rateLimit(120), async (c) => {
    const user = c.get("user");
    if (!user) throw unauthorized("Authentication required");
    const body = parseBody(desktopCommandSchema, await readJsonBody(c));
    // No lease here any more. This path carries no run id, so the
    // desktop routes it to the ACTIVE USER TAB and refuses outright if
    // that tab belongs to a run — a manual caller must not reach into a
    // surface an agent is working in, exactly as an agent cannot reach
    // into the user's.
    try {
      const result = await sendCommand(user.id, body.method, body.params ?? {}, {
        ...(body.timeout_ms !== undefined ? { timeoutMs: body.timeout_ms } : {}),
      });
      return c.json({ result });
    } catch (err) {
      throw desktopErrorToApiError(err);
    }
  });

  router.post("/internal/desktop-command", rateLimitByBearer(200), async (c) => {
    const { runId, run } = await verifyRunToken(c);
    if (!run.userId) {
      throw forbidden("Run has no owning user — the desktop bridge requires a user-owned run");
    }
    const body = parseBody(desktopAgentCommandSchema, await readJsonBody(c));
    const batchSteps =
      body.method === "browser.batch"
        ? ((body.params ?? {}) as { steps?: Array<{ method?: string; params?: unknown }> }).steps
        : undefined;
    const policy = await assertDesktopCapability(run, runId, body.method, batchSteps);
    if (body.method === "browser.navigate") {
      assertAuthorizedTarget(policy, (body.params as { url?: unknown } | undefined)?.url);
    } else if (body.method === "browser.download") {
      const download = body.params as { url?: unknown; selector?: unknown } | undefined;
      if (typeof download?.url === "string") {
        assertAuthorizedTarget(policy, download.url);
      }
    } else if (Array.isArray(batchSteps)) {
      for (const [index, step] of batchSteps.entries()) {
        if (step?.method === "browser.navigate") {
          assertAuthorizedTarget(
            policy,
            (step.params as { url?: unknown } | undefined)?.url,
            `params.steps[${index}].params.url`,
          );
        }
        if (step?.method === "browser.download") {
          const download = step.params as { url?: unknown; selector?: unknown } | undefined;
          if (typeof download?.url === "string") {
            assertAuthorizedTarget(policy, download.url, `params.steps[${index}].params.url`);
          }
        }
      }
    }

    // Status polling reads platform state and never touches Electron.
    // Everything else resolves (and, the first time, opens) the tab this
    // run drives.
    let tabId: string | null = null;
    if (body.method !== "browser.download_status") {
      if (!isConnected(run.userId)) {
        throw serviceUnavailable("No Appstrate Desktop connected for this user");
      }
      try {
        if (TAB_LIFECYCLE_METHODS.has(body.method)) {
          return await handleTabsCommand(c, run, runId, policy, body);
        }
        tabId = await resolveRunTab(run, runId, policy, body.tab_id, body.timeout_ms);
        // Serialize runs that share a profile on the same site. With one
        // profile per agent the keys never collide, so this only fires
        // between two runs of the same agent, or under `session: "user"`.
        const navigationTargets = [
          body.method === "browser.navigate" || body.method === "browser.download"
            ? (body.params as { url?: unknown } | undefined)?.url
            : undefined,
          ...(batchSteps ?? []).map((step) =>
            step?.method === "browser.navigate" || step?.method === "browser.download"
              ? (step.params as { url?: unknown } | undefined)?.url
              : undefined,
          ),
        ];
        for (const target of navigationTargets) {
          if (typeof target !== "string") continue;
          acquireDesktopOriginLease(policy.partition, target, runId);
          noteDesktopTabOrigin(run.userId, tabId, target);
        }
      } catch (err) {
        throw desktopErrorToApiError(err);
      }
    }

    let dispatchedParams: unknown = body.params ?? {};

    // `browser.request_human` — the agent stops and asks for a person
    // (a code by SMS, a hardware key, a challenge it cannot clear). The
    // desktop parks the tab and shows the message; this call stays
    // pending until the user hands the tab back, so nothing the agent
    // sends can race what the person is doing. A timeout is not a
    // failure: the tab stays parked and the run may ask again.
    if (body.method === "browser.request_human") {
      const message = (body.params as { message?: unknown } | undefined)?.message;
      if (typeof message !== "string" || message.trim().length === 0) {
        throw invalidRequest(
          "`params.message` must tell the user what you need from them",
          "params",
        );
      }
      try {
        await sendCommand(
          run.userId,
          "human.request",
          { message },
          { timeoutMs: 15_000, tabId: tabId!, runId },
        );
      } catch (err) {
        throw desktopErrorToApiError(err);
      }
      // Mark it parked HERE rather than waiting for the desktop's
      // notification: the tab belongs to the person from the moment the
      // request lands, and any other command from this run in the
      // meantime must get a clear 409 instead of a desktop-side refusal
      // surfacing as a bad gateway.
      setDesktopTabPaused(run.userId, tabId!, true);
      logger.info("Desktop run parked on a human", { runId, tabId, module: "desktop" });
      const resumed = await awaitHumanHandoff(run.userId, tabId!, HUMAN_HANDOFF_TIMEOUT_MS);
      return c.json({
        result: resumed
          ? { resumed: true }
          : {
              resumed: false,
              timed_out: true,
              hint: "the tab is still parked — ask again to keep waiting, or stop and report",
            },
      });
    }

    // `browser.capture_credential` — the write-only path that lands a
    // freshly-logged-in session token (or any in-page secret) into the
    // integration credential store, so the rest of the run reaches the
    // site's API through the normal `api_call` + MITM credential proxy
    // (server-side injection, cross-host per `authorized_uris`, agent
    // never sees the value). The captured value travels desktop →
    // platform server-side and goes STRAIGHT to the store: the agent
    // gets back only `{ captured: true, fields }`, never a value.
    if (body.method === "browser.capture_credential") {
      try {
        recordDesktopExposure(policy.partition, runId, "credential_substitution");
      } catch (err) {
        throw desktopErrorToApiError(err);
      }
      return captureCredential(c, run, runId, body, tabId!);
    }

    const requestsEvaluate =
      body.method === "browser.evaluate" ||
      (Array.isArray(batchSteps) && batchSteps.some((step) => step?.method === "browser.evaluate"));
    if (requestsEvaluate && body.substitute_params) {
      throw invalidRequest(
        "browser.evaluate and credential substitution cannot be combined in one command",
        "substitute_params",
      );
    }
    if (requestsEvaluate) {
      try {
        recordDesktopExposure(policy.partition, runId, "arbitrary_evaluate");
      } catch (err) {
        throw desktopErrorToApiError(err);
      }
    }

    // `browser.batch` is exempt here: its allowlist applies PER STEP
    // inside the batch branch below.
    if (
      body.substitute_params &&
      body.method !== "browser.batch" &&
      !SUBSTITUTABLE_METHODS.has(body.method)
    ) {
      throw invalidRequest(
        `Substitution is not allowed for ${body.method} — only ` +
          `${[...SUBSTITUTABLE_METHODS].join(", ")} keep the value on the user's machine`,
        "substitute_params",
      );
    }

    // Credential substitution — resolve the run's connected credentials
    // for the named integration and swap `{{field}}` placeholders out of
    // `params` before dispatching. The agent's LLM only ever writes
    // templates; the resolved values go straight to the user's desktop.
    if (body.substitute_params && body.method !== "browser.batch") {
      const fields = await resolveSubstitutionFields(body.integration_id, run, runId);
      try {
        recordDesktopExposure(policy.partition, runId, "credential_substitution");
      } catch (err) {
        throw desktopErrorToApiError(err);
      }
      // From now on, every reply for this run is scrubbed of these
      // values — including replies to later commands (an agent could
      // fill a password and read the field back with a second call).
      dispatchedParams = substituteInValue(body.params ?? {}, fields);
      logger.info("Desktop command credential substitution", {
        runId,
        integrationId: body.integration_id,
        fieldCount: Object.keys(fields).length,
        module: "desktop",
      });
    }

    // `browser.batch` — a frozen sequence executed desktop-side in one
    // round-trip. The platform stays the trust boundary: it validates
    // the step vocabulary, applies credential substitution PER STEP,
    // mints upload targets for download steps, dispatches the whole
    // list as ONE WS message, and scrubs the result array.
    if (body.method === "browser.batch") {
      const p = (body.params ?? {}) as { steps?: Array<{ method?: string; params?: unknown }> };
      if (!Array.isArray(p.steps) || p.steps.length === 0) {
        throw invalidRequest("`params.steps` must be a non-empty array", "params");
      }
      if (p.steps.length > BATCH_MAX_STEPS) {
        throw invalidRequest(`Batch is capped at ${BATCH_MAX_STEPS} steps`, "params");
      }
      for (const [i, st] of p.steps.entries()) {
        if (!st || typeof st.method !== "string" || !BATCHABLE_METHODS.has(st.method)) {
          throw invalidRequest(`Step ${i}: method not batchable: ${String(st?.method)}`, "params");
        }
      }
      let fields: Record<string, string> | null = null;
      if (body.substitute_params) {
        fields = await resolveSubstitutionFields(body.integration_id, run, runId);
        try {
          recordDesktopExposure(policy.partition, runId, "credential_substitution");
        } catch (err) {
          throw desktopErrorToApiError(err);
        }
        logger.info("Desktop batch credential substitution", {
          runId,
          integrationId: body.integration_id,
          steps: p.steps.length,
          module: "desktop",
        });
      }
      const prepared: Array<{ method: string; params: unknown }> = [];
      for (const st of p.steps) {
        let stepParams: unknown = st.params ?? {};
        // Per-step allowlist: only fill gets its placeholders resolved;
        // every other step keeps `{{…}}` literal, so neither an outbound
        // URL nor arbitrary page JavaScript can receive a secret.
        if (fields && SUBSTITUTABLE_METHODS.has(st.method!)) {
          stepParams = substituteInValue(stepParams, fields);
        }
        if (st.method === "browser.download") {
          const dp = stepParams as {
            url?: string;
            selector?: string;
            filename?: string;
            max_bytes?: number;
          };
          if (
            (!dp.url || !/^https?:\/\//.test(dp.url)) &&
            (!dp.selector || typeof dp.selector !== "string")
          ) {
            throw invalidRequest("download step needs an http(s) `url` or `selector`", "params");
          }
          const { record, uploadUrl, maxBytes } = await createDownload({
            runId,
            userId: run.userId,
            ...(typeof dp.filename === "string" ? { filename: dp.filename } : {}),
            ...(typeof dp.max_bytes === "number" ? { maxBytes: dp.max_bytes } : {}),
          });
          stepParams = {
            download_id: record.downloadId,
            ...(dp.selector ? { selector: dp.selector } : { url: dp.url }),
            filename: record.filename,
            upload_url: uploadUrl,
            max_bytes: maxBytes,
          };
        }
        prepared.push({ method: st.method!, params: stepParams });
      }
      const scrubBatch = (text: string): string => scrubRunSecrets(runId, text) as string;
      try {
        const result = await sendCommand(
          run.userId,
          "browser.batch",
          { steps: prepared },
          {
            timeoutMs: body.timeout_ms,
            authorizedUris: policy.authorizedUris,
            ...(tabId ? { tabId } : {}),
            runId,
          },
        );
        return c.json({ result: scrubRunSecrets(runId, result) });
      } catch (err) {
        throw desktopErrorToApiError(err, scrubBatch);
      }
    }

    // `browser.download` / `browser.download_status` are platform-mediated:
    // the ORDER goes to the desktop with a freshly minted upload target,
    // the STATUS is answered from the platform's own record (fed by the
    // desktop's notifications) — no round-trip for polling.
    if (body.method === "browser.download") {
      const p = (body.params ?? {}) as {
        url?: string;
        selector?: string;
        filename?: string;
        max_bytes?: number;
      };
      if (
        (!p.url || typeof p.url !== "string" || !/^https?:\/\//.test(p.url)) &&
        (!p.selector || typeof p.selector !== "string")
      ) {
        throw invalidRequest(
          "`params.url` must be an http(s) URL, or `params.selector` must identify the download control",
          "params",
        );
      }
      const { record, uploadUrl, maxBytes } = await createDownload({
        runId,
        userId: run.userId,
        ...(typeof p.filename === "string" ? { filename: p.filename } : {}),
        ...(typeof p.max_bytes === "number" ? { maxBytes: p.max_bytes } : {}),
      });
      try {
        await sendCommand(
          run.userId,
          "browser.download",
          {
            download_id: record.downloadId,
            ...(p.selector ? { selector: p.selector } : { url: p.url }),
            filename: record.filename,
            upload_url: uploadUrl,
            max_bytes: maxBytes,
          },
          {
            timeoutMs: body.timeout_ms,
            authorizedUris: policy.authorizedUris,
            ...(tabId ? { tabId } : {}),
            runId,
          },
        );
      } catch (err) {
        throw desktopErrorToApiError(err);
      }
      return c.json({ result: toStatusPayload(record) });
    }
    if (body.method === "browser.download_status") {
      const p = (body.params ?? {}) as { download_id?: string };
      if (!p.download_id || typeof p.download_id !== "string") {
        throw invalidRequest("`params.download_id` is required", "params");
      }
      const rec = getDownloadForRun(runId, p.download_id);
      if (!rec) throw notFound(`Unknown download '${p.download_id}' for this run`);
      return c.json({ result: toStatusPayload(rec) });
    }

    const scrub = (text: string): string => scrubRunSecrets(runId, text) as string;
    try {
      const result = await sendCommand(run.userId, body.method, dispatchedParams, {
        timeoutMs: body.timeout_ms,
        authorizedUris: policy.authorizedUris,
        ...(tabId ? { tabId } : {}),
        runId,
      });
      return c.json({ result: scrubRunSecrets(runId, result) });
    } catch (err) {
      throw desktopErrorToApiError(err, scrub);
    }
  });

  // GET /internal/desktop-download/{downloadId} — the run-side fetch of a
  // completed download's bytes. Streamed straight from storage (S3 or FS)
  // with no buffering; run-token auth + run-scoped record lookup, so a
  // leaked token cannot fetch another run's downloads. The sidecar calls
  // this once per download and serves the agent-side extension from its
  // local copy.
  router.get("/internal/desktop-download/:downloadId", rateLimitByBearer(200), async (c) => {
    const { runId } = await verifyRunToken(c);
    const downloadId = c.req.param("downloadId") ?? "";
    const rec = getDownloadForRun(runId, downloadId);
    if (!rec) throw notFound(`Unknown download '${downloadId}' for this run`);
    if (rec.state !== "uploaded") {
      throw invalidRequest(`Download is '${rec.state}', not 'uploaded'`, "downloadId");
    }
    const stream = await storageDownloadStream(DOWNLOADS_BUCKET, rec.storageKey);
    if (!stream) throw notFound("Download bytes are gone (retention elapsed)");
    return new Response(boundedDownloadStream(stream, rec.maxBytes, rec.size), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${rec.filename.replace(/["\\]/g, "_")}"`,
      },
    });
  });

  return router;
}
