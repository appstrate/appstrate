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
import {
  listIntegrationConnections,
  saveIntegrationConnection,
} from "../../services/integration-connections.ts";
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
  createDownload,
  getDownloadForRun,
  toStatusPayload,
  DOWNLOADS_BUCKET,
} from "./downloads.ts";
import { downloadStream as storageDownloadStream } from "@appstrate/db/storage";

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
  run: { packageId: string; orgId: string },
  runId: string,
): Promise<void> {
  const agent = await getPackage(run.packageId, run.orgId, { includeEphemeral: true });
  if (!agent) throw notFound("Agent not found");
  const deps = asRecord(asRecord(agent.manifest).dependencies);
  const integrations = asRecord(deps.integrations);
  if (!(integrationId in integrations)) {
    logger.warn("Desktop substitution rejected — integration not declared by agent", {
      runId,
      integrationId,
      agentId: agent.id,
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
 * user's machine: a DOM field (`fill`) or an in-page script
 * (`evaluate` — whose exfiltration surface is bounded by the
 * integration's `authorized_uris`; capturing the session token with
 * `browser.capture_credential` and reaching the API through `api_call`
 * removes the need to read tokens in-page at all).
 */
const SUBSTITUTABLE_METHODS = new Set(["browser.fill", "browser.evaluate"]);

type RunContext = Awaited<ReturnType<typeof verifyRunToken>>["run"];

/**
 * `browser.capture_credential` handler. Runs an in-page script on the
 * desktop that returns a `{ field: value }` object, then writes it to
 * the run actor's connection for `integration_id` / `auth_key` — an
 * upsert (find the actor's existing row for that auth, else insert).
 * The value only ever transits desktop → platform → credential store;
 * the agent receives just the field NAMES back, and the values are
 * registered for reply-scrubbing as a belt.
 *
 * Same fail-closed gate as substitution: the running agent must declare
 * the integration. This is a genuine new capability (a run writing to
 * its own credential store), so it stays tightly scoped: the declared
 * integration only, the run actor's own connection only, write-only.
 */
/**
 * Union of an integration's `authorized_uris` across all its auths, at
 * the version this run froze. The capture page must fall inside it.
 * Empty (no manifest / no auths) → the caller rejects every page, which
 * is the safe default for a write-into-credential-store operation.
 */
async function loadIntegrationAuthorizedUris(
  integrationId: string,
  run: RunContext,
): Promise<string[]> {
  const frozen = run.resolvedIntegrationVersions?.[integrationId] ?? null;
  const loaded = await readIntegrationManifestForRun(integrationId, frozen);
  if (!loaded.ok) return [];
  const auths = asRecord(asRecord(loaded.manifest).auths);
  const uris: string[] = [];
  for (const auth of Object.values(auths)) {
    const list = asRecord(auth).authorized_uris;
    if (Array.isArray(list)) {
      for (const u of list) if (typeof u === "string") uris.push(u);
    }
  }
  return uris;
}

async function captureCredential(
  c: Context<AppEnv>,
  run: RunContext,
  runId: string,
  body: { params?: unknown; timeout_ms?: number },
): Promise<Response> {
  if (!run.userId) {
    throw forbidden("capture_credential requires a user-owned run");
  }
  const p = (body.params ?? {}) as { integration_id?: string; auth_key?: string; script?: string };
  if (!p.integration_id || !p.auth_key || !p.script) {
    throw invalidRequest("capture_credential needs integration_id, auth_key and script", "params");
  }
  await assertAgentDeclaresIntegration(p.integration_id, run, runId);

  // The union of the integration's declared `authorized_uris`, across
  // all its auths. The capture page MUST be inside it (checked below) —
  // otherwise a run could sit on `bank.com`, capture that session's
  // token, and file it into ANY declared integration, whose api_call
  // authorized_uris would then exfiltrate it. Binding the SOURCE page to
  // the integration's own domain is the missing half of the guard: you
  // can only capture a site's secret while browsing that same site.
  const integrationUris = await loadIntegrationAuthorizedUris(p.integration_id, run);

  // One dispatch returns BOTH the page URL (for the domain check) and
  // the captured fields — received HERE (server-side), never forwarded
  // to the agent. Wrapping the caller's script keeps its return value
  // under `fields`.
  const wrapped = `(() => ({ __url: location.href, fields: (${p.script}) }))()`;
  let raw: unknown;
  try {
    raw = await sendCommand(
      run.userId,
      "browser.evaluate",
      { script: wrapped },
      {
        timeoutMs: body.timeout_ms,
      },
    );
  } catch (err) {
    throw desktopErrorToApiError(err);
  }
  const envelope = raw as { __url?: unknown; fields?: unknown };
  const pageUrl = typeof envelope?.__url === "string" ? envelope.__url : "";
  if (!pageUrl || !integrationUris.some((u) => matchesAuthorizedUriSpec(u, pageUrl))) {
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
    throw badGateway("capture script must return an object of { field: value } string pairs");
  }
  const credentials: Record<string, string> = {};
  for (const [k, v] of Object.entries(captured as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) credentials[k] = v;
  }
  if (Object.keys(credentials).length === 0) {
    throw badGateway("capture script returned no non-empty string fields");
  }

  const scope = { orgId: run.orgId, applicationId: run.applicationId };
  const actor = actorFromIds(run.userId, run.endUserId);
  if (!actor) throw forbidden("capture_credential requires a run actor");
  // Upsert: reuse the actor's existing row for this (integration, auth),
  // else insert a fresh one.
  const existing = await listIntegrationConnections(scope, p.integration_id, actor);
  const match = existing.find((x) => x.auth_key === p.auth_key);
  await saveIntegrationConnection(scope, {
    packageId: p.integration_id,
    authKey: p.auth_key,
    accountId: match?.account_id ?? "captured",
    credentials,
    actor,
    ...(match ? { connectionId: match.id } : {}),
  });
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

export const desktopCommandSchema = z.object({
  method: z.enum([
    "browser.navigate",
    "browser.click",
    "browser.fill",
    "browser.evaluate",
    "browser.screenshot",
    "browser.waitForSelector",
    "browser.download",
    "browser.download_status",
    "browser.capture_credential",
    "browser.batch",
  ]),
  params: z.record(z.string(), z.unknown()).optional(),
  timeout_ms: z.number().int().min(1000).max(120000).optional(),
});

export const desktopAgentCommandSchema = desktopCommandSchema.extend({
  integration_id: z.string().optional(),
  substitute_params: z.boolean().optional(),
});

async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw invalidRequest("Invalid JSON body");
  }
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
        onMessage: (evt): void => {
          let parsed: { id?: string; method?: string; result?: unknown };
          try {
            const raw = typeof evt.data === "string" ? evt.data : evt.data.toString();
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
    try {
      const result = await sendCommand(user.id, body.method, body.params ?? {}, {
        timeoutMs: body.timeout_ms,
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

    let dispatchedParams: unknown = body.params ?? {};

    // `browser.capture_credential` — the write-only path that lands a
    // freshly-logged-in session token (or any in-page secret) into the
    // integration credential store, so the rest of the run reaches the
    // site's API through the normal `api_call` + MITM credential proxy
    // (server-side injection, cross-host per `authorized_uris`, agent
    // never sees the value). The captured value travels desktop →
    // platform server-side and goes STRAIGHT to the store: the agent
    // gets back only `{ captured: true, fields }`, never a value.
    if (body.method === "browser.capture_credential") {
      return captureCredential(c, run, runId, body);
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
    if (body.substitute_params) {
      const fields = await resolveSubstitutionFields(body.integration_id, run, runId);
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
        // Per-step allowlist: only fill/evaluate get their placeholders
        // resolved; a navigate/download step keeps `{{…}}` literal, so
        // no secret can ride an outbound URL.
        if (fields && SUBSTITUTABLE_METHODS.has(st.method!)) {
          stepParams = substituteInValue(stepParams, fields);
        }
        if (st.method === "browser.download") {
          const dp = stepParams as {
            url?: string;
            capture?: boolean;
            filename?: string;
            max_bytes?: number;
          };
          if (dp.capture !== true && (!dp.url || !/^https?:\/\//.test(dp.url))) {
            throw invalidRequest("download step needs `url` or `capture: true`", "params");
          }
          const { record, uploadUrl, maxBytes } = await createDownload({
            runId,
            userId: run.userId,
            ...(typeof dp.filename === "string" ? { filename: dp.filename } : {}),
            ...(typeof dp.max_bytes === "number" ? { maxBytes: dp.max_bytes } : {}),
          });
          stepParams = {
            download_id: record.downloadId,
            ...(dp.capture === true ? { capture: true } : { url: dp.url }),
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
          { timeoutMs: body.timeout_ms },
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
        capture?: boolean;
        filename?: string;
        max_bytes?: number;
      };
      // Two trigger modes: a direct URL the desktop navigates to, or
      // `capture: true` — the order claims the next download the PAGE
      // starts (blob anchor clicks, in-page authenticated fetches).
      if (
        p.capture !== true &&
        (!p.url || typeof p.url !== "string" || !/^https?:\/\//.test(p.url))
      ) {
        throw invalidRequest(
          "`params.url` must be an http(s) URL (or set `params.capture`)",
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
            ...(p.capture === true ? { capture: true } : { url: p.url }),
            filename: record.filename,
            upload_url: uploadUrl,
            max_bytes: maxBytes,
          },
          { timeoutMs: body.timeout_ms },
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
    return new Response(stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        ...(rec.size !== null ? { "Content-Length": String(rec.size) } : {}),
      },
    });
  });

  return router;
}
