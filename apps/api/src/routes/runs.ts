// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  getRun,
  getRunFull,
  getRunningRunsForPackage,
  deletePackageRuns,
  listPackageRuns,
  listGlobalRuns,
  listRunLogs,
  RUN_LOG_LEVELS,
  GLOBAL_RUN_KINDS,
} from "../services/state/runs.ts";
import { listUserRuns } from "../services/state/notifications.ts";
import { resolveAgentRunVersion } from "../services/agent-version-resolver.ts";
import { parseRequestInput } from "../services/input-parser.ts";
import { getInstalledPackageSettings } from "../services/application-packages.ts";
import { deleteRunWorkspace } from "../services/run-workspace-storage.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { abortRun } from "../services/run-tracker.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { idempotency } from "../middleware/idempotency.ts";
import { invalidRequest, notFound, conflict, internalError } from "../lib/errors.ts";
import { listResponse } from "../lib/list-response.ts";
import { setOffsetLinkHeader, setSinceLinkHeader } from "../lib/pagination-link.ts";
import { parseListPagination } from "../lib/list-query.ts";
import { requireAgent } from "../middleware/guards.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { stopWorkloadAndWait } from "../services/stop-workload.ts";
import { logger } from "../lib/logger.ts";
import { prepareAndExecuteRun, resolveRunPreflight } from "../services/run-pipeline.ts";
import type { IntegrationManifestCache } from "../services/integration-service.ts";
import { assertExplicitModelExists } from "../services/org-models.ts";
import { resolveRunnerContext } from "../lib/runner-context.ts";
import { getActor } from "../lib/actor.ts";
import { getAppScope } from "../lib/scope.ts";
import { getInlineRunLimits } from "../services/run-limits.ts";
import {
  assertContextFilesFieldAvailable,
  injectContextFiles,
  normalizeContextFileUris,
  triggerInlineRun,
} from "../services/inline-run.ts";
import { runInlinePreflight } from "../services/inline-run-preflight.ts";
import { synthesiseFinalize } from "../services/run-event-ingestion.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import { currentTraceparent, telemetryTrustsIncomingTrace } from "@appstrate/core/telemetry";
import { TERMINAL_RUN_STATUSES, runStatusValues } from "@appstrate/db/schema";
import { parseWaitQuery, waitForRunTerminal } from "../services/run-wait.ts";
import { SCOPED_PACKAGE_ROUTE } from "./scoped-package-route.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { modelGenerationSettingsSchema } from "@appstrate/core/model-generation";

/**
 * Wire-shape guard for the agent-run body (`POST /agents/{scope}/{name}/run`).
 *
 * `.strict()` on purpose (#1187). This surface had NO body schema at all: the
 * body was read with `c.req.json<RunRequestBody>()`, a cast that validates
 * nothing, so an unknown field was dropped without a trace and a malformed body
 * became `{}` — a 201 for a run executing with parameters nobody asked for.
 * That is the exact failure `assertFieldsUnlocked` states as a rule
 * (`input-resolution.ts`) and the one #1179 fixed on the MCP surface, and the
 * launch body was the last place the rule did not hold. `POST /runs/remote` was
 * already `.strict()`; the three launch surfaces now agree.
 *
 * Deep semantics stay downstream in `parseRequestInput` (is this dependency
 * spec resolvable, does the replayed run belong to this agent) — this schema
 * only settles which fields exist and of what type.
 */
export const runAgentBodySchema = z
  .object({
    input: z.record(z.string(), z.unknown()).optional(),
    /**
     * Replay a prior run's persisted input. Emptiness and the mutual exclusion
     * with `input` are checked in `parseRequestInput`, which owns the message
     * naming the field — neither is a shape.
     */
    rerun_from: z.string().optional(),
    modelId: z.string().optional(),
    generation: modelGenerationSettingsSchema.optional(),
    proxyId: z.string().optional(),
    /** `.min(1)` for the same reason it is set on the inline schema below. */
    connection_overrides: z.record(z.string(), z.string().min(1)).optional(),
    dependency_overrides: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/**
 * Wire-shape guard for the inline-run body (`POST /runs/inline` +
 * `/inline/validate`). Mirrors the `InlineRunBody` TS type: every field
 * is optional and the semantic validation (manifest/input/AJV) happens
 * downstream in the preflight — this schema only rejects a malformed body or a
 * grossly wrong-typed field (e.g. `input: "foo"`) with a 400 instead of letting
 * it cast through and surface later as a 500.
 *
 * `.strict()` since #1187, like the two other launch surfaces. It also closes
 * a live silent drop: `dependency_overrides` was accepted here (the parser read
 * it straight off the raw body) and then never applied — `triggerInlineRun`
 * does not forward it. Undeclared here, it is now a 400 instead of a run that
 * quietly ignored the pin it was handed.
 */
const inlineRunBodySchema = z
  .object({
    manifest: z.unknown().optional(),
    prompt: z.unknown().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    modelId: z.string().nullable().optional(),
    generation: modelGenerationSettingsSchema.optional(),
    proxyId: z.string().nullable().optional(),
    /**
     * `appfile://` URIs to mount read-only into the run's input-file directory
     * without declaring a file field in the manifest (fan-in by reference). Entry
     * shape is checked downstream by `normalizeContextFileUris` so the error
     * names the offending URI rather than a Zod path.
     */
    context_files: z.array(z.unknown()).optional(),
    /**
     * Per-integration connection picks for this run (resolver mechanism #2).
     * Declared here so the parse keeps the field for the preflight's readiness
     * gate, which runs BEFORE `parseRequestInput` and would otherwise never see
     * it.
     *
     * `.min(1)` is owned here rather than delegated to `parseRequestInput`: an
     * empty-string id is falsy at the resolver's `resolveOne`, so readiness would
     * answer 412 before the parser's field-precise 400 could fire — and
     * `POST /runs/inline/validate` never calls the parser at all, so the guard
     * would have no owner there and the validator would disagree with the launch
     * on the same body.
     */
    connection_overrides: z.record(z.string(), z.string().min(1)).optional(),
    /**
     * Not a field — a rejection. `rerun_from` is an agent-route concept (replay a
     * cataloged agent's prior input) and means nothing here, so its presence must
     * fail loudly rather than be silently stripped and half-applied: the inline
     * preflight validates the raw `input`, which a replay would not populate.
     *
     * Declared as `z.undefined()` so the rule lives in the schema and travels
     * with it, instead of being re-derived from a second `c.req.json()` read of
     * the same body. It also puts the failure on the documented side of the error
     * convention (see `responses.ts` → `ValidationError`): body-level failures
     * answer `validation_failed` with a populated `errors[]`, and `invalid_request`
     * is for single-field failures OUTSIDE the body. The hand-rolled throw this
     * replaced emitted `invalid_request` from inside a body check.
     */
    rerun_from: z
      .undefined({ error: "`rerun_from` is not supported for inline runs — pass `input` directly" })
      .optional(),
  })
  .strict();

/**
 * Resolve the traceparent to seed the run-execution trace tree with, honoring
 * the same anti-spoof gate as the SERVER span. When the telemetry provider
 * trusts inbound traces (the observability module's `OTEL_TRUST_INCOMING_TRACE`)
 * we adopt the caller-supplied inbound header; when off we never trust it
 * — we fall back to the in-process SERVER span (via `currentTraceparent()`) so
 * the run spans stay in THIS process's trace instead of the unverified inbound
 * one. Returns `undefined` when no telemetry provider is installed or no span
 * is active, which makes the run span a fresh root (a no-op when telemetry is
 * off).
 */
export function runTraceparent(c: Context<AppEnv>): string | undefined {
  return telemetryTrustsIncomingTrace() ? c.get("traceparent") : currentTraceparent();
}

/** The closed set `GET /api/runs?user=` accepts. One member, for now. */
const USER_FILTERS = ["me"] as const;

/**
 * Read a query parameter whose accepted values are a closed set.
 *
 * **An unrecognised value is a 400, never `undefined`.** Every user of this
 * helper is a *filter*, and silently dropping a filter widens the result set:
 * `?kind=inlinee` would return every kind, `?status=succes` every status, to a
 * caller reading the response as narrowed. That is the failure mode worth
 * spending a 400 on — the caller gets a list that looks right and is wrong.
 *
 * **Present-but-empty (`?kind=`) reads as absent.** An empty value is how a
 * form, a URL builder, or a client that always emits its keys spells "no
 * filter"; rejecting it would break those callers without protecting anyone.
 * That is not the silent-widening case: nothing was requested, so nothing is
 * dropped.
 *
 * The `allowed` tuple is also what the OpenAPI operation declares as the
 * parameter's `enum`, so the spec and the runtime check state the same set.
 */
function closedSetQuery<T extends string>(
  c: Context<AppEnv>,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw invalidRequest(`${name} must be one of: ${allowed.join(", ")}`, name);
  }
  return raw as T;
}

// --- Router ---

export function createRunsRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/agents/:scope/:name/run — execute an agent (fire-and-forget, returns JSON)
  router.post(
    `/agents/${SCOPED_PACKAGE_ROUTE}/run`,
    rateLimit(20),
    idempotency(),
    requireAgent(),
    requirePermission("agents", "run"),
    async (c) => {
      const agent = c.get("package");
      const orgId = c.get("orgId");
      const actor = getActor(c);

      // Body first: it is a property of the request, so a body this surface
      // cannot honour fails before any lookup. `allowEmpty` keeps the launch
      // contract "no body == no input" (a run whose input is entirely resolved
      // from stored values needs no body at all) while MALFORMED JSON now 400s
      // instead of being swallowed into `{}` and launched as an input-less run.
      const body = await readJsonBody(c, runAgentBodySchema, { allowEmpty: true });

      // Version selector from query param: `draft`, `published`, or a
      // version spec (exact / dist-tag / semver range). Omitted ≡ `published`
      // for EVERY caller (latest published; 404 when none, #636) — the working
      // copy is opt-in via `version=draft` only, never an implicit default.
      // The editor UI passes `version=draft` explicitly.
      const versionOverride = c.req.query("version");
      const { agent: effectiveAgent, overrideVersionLabel } = await resolveAgentRunVersion(
        agent,
        versionOverride,
      );

      // Single canonical prefix — `run_` — shared with inline + remote origins.
      // Minted BEFORE input parsing so input files can be streamed straight
      // into this run's workspace namespace during consume (no buffering them in
      // API memory until the run row exists). The run row is still created later
      // with this same id.
      const runId = `run_${crypto.randomUUID()}`;

      // Flips true the instant the pipeline launches (run row inserted, workload
      // dispatched). Past that point the run OWNS its workspace — a later failure
      // (e.g. the read-back below) must NOT delete a live run's input files.
      let launched = false;
      try {
        // Per-application settings first: they carry the editor defaults and
        // the locked-field list the input resolution needs, and the readiness
        // preflight below reuses this same row (one read per trigger).
        const packageSettings = await getInstalledPackageSettings(c.get("applicationId"), agent.id);

        const inputResult = await parseRequestInput(
          c,
          body,
          runId,
          effectiveAgent.manifest.input?.schema
            ? asJSONSchemaObject(effectiveAgent.manifest.input.schema)
            : undefined,
          {
            // Same-agent gate for `rerun_from` — replaying another agent's run
            // input is rejected with 409 `rerun_agent_mismatch`.
            agentPackageId: agent.id,
            editorDefaults: packageSettings.values,
            lockedFields: packageSettings.locked,
          },
        );

        const {
          input: parsedInput,
          uploadedFiles,
          pendingFiles,
          consumedFileIds,
          modelIdOverride,
          generationConfigOverride,
          proxyIdOverride,
          connectionOverrides,
          dependencyOverrides,
        } = inputResult;

        // An explicit per-run `modelId` override must reference a real model
        // (system key or org-model UUID). Reject unknown/malformed values with a
        // clean 404 rather than letting them silently fall through to the org
        // default downstream (or crash the uuid cast — see loadModel).
        await assertExplicitModelExists(orgId, modelIdOverride);

        // Shared preflight: validate readiness. Threading
        // `connectionOverrides` here is what makes the
        // MissingConnectionsModal retry actually work — readiness sees the
        // caller's pick and skips the must_choose error on >1 candidates.
        // Pre-fix, the readiness gate fired must_choose regardless of the
        // override, so the picker UX loop never exited.
        // One manifest memo for the whole trigger — readiness (preflight),
        // the connection-snapshot pass, and the spawn resolver inside
        // `prepareAndExecuteRun` all load the same integration manifests;
        // sharing the Map collapses those repeats into one SELECT + Zod
        // parse per integration. Request-scoped: dies with this handler.
        const manifestCache: IntegrationManifestCache = new Map();

        const {
          modelId: preflightModelId,
          generationConfig: preflightGenerationConfig,
          proxyId: preflightProxyId,
        } = await resolveRunPreflight({
          agent: effectiveAgent,
          applicationId: c.get("applicationId"),
          orgId,
          actor,
          packageSettings,
          connectionOverrides: connectionOverrides ?? null,
          manifestCache,
        });

        const runner = await resolveRunnerContext(c);
        await prepareAndExecuteRun({
          runId,
          agent: effectiveAgent,
          orgId,
          actor,
          // `parseRequestInput` collapses an effectively-empty input to
          // `undefined`; map that to NULL so an input-less run persists
          // `runs.input` as SQL NULL (one representation across all origins).
          input: parsedInput ?? null,
          // File metadata for prompt context — the file bytes were already
          // streamed into the run workspace during consume.
          files: uploadedFiles,
          // Staged uploads to materialize into durable `files` rows after
          // the run row exists (input already rewritten to `appfile://` ids).
          pendingFiles,
          // `appfile://` inputs to protect via `file_links` (chaining).
          consumedFileIds,
          modelId: modelIdOverride ?? preflightModelId,
          generationConfig: preflightGenerationConfig,
          generationConfigOverride: generationConfigOverride ?? null,
          proxyId: proxyIdOverride ?? preflightProxyId,
          overrideVersionLabel,
          dependencyOverrides: dependencyOverrides ?? null,
          applicationId: c.get("applicationId"),
          apiKeyId: c.get("apiKeyId") ?? undefined,
          connectionOverrides: connectionOverrides ?? null,
          traceparent: runTraceparent(c),
          runnerName: runner.name,
          runnerKind: runner.kind,
          manifestCache,
        });
        // Pipeline launched — the run now owns its workspace teardown.
        launched = true;

        await recordAuditFromContext(c, {
          action: "run.triggered",
          resourceType: "run",
          resourceId: runId,
          after: {
            packageId: agent.id,
            versionLabel: overrideVersionLabel ?? null,
            origin: "platform",
          },
        });

        // 201 + the bare created run resource — same DTO and serializer as
        // GET /runs/:id — so callers see the full launched state (resolved
        // `model_label` / `model_source` for org-default drift detection per
        // #635, plus status, version_ref, agent_scope, …) without a follow-up
        // GET. The run row exists once `prepareAndExecuteRun` resolves.
        // No legacy `runId` alias (#657): the run id is `id`.
        const row = await getRunFull(getAppScope(c), runId, getActor(c));
        if (!row) {
          // The run row was inserted by `prepareAndExecuteRun` above and is
          // read back on the same scope, so a miss means it was deleted out
          // from under us (a concurrent teardown raced creation) — the
          // resource genuinely no longer exists. A 201 must carry the full
          // `Run`; returning a partial body would lie to the typed client.
          // This is a server-side anomaly, so surface a 500 rather than a
          // half-resource. Effectively unreachable in normal operation.
          throw internalError();
        }
        return c.json(row, 201);
      } catch (err) {
        // Roll back any input files streamed into the run workspace before
        // the run launched (size/MIME mismatch, failed preflight, …). Once
        // `prepareAndExecuteRun` resolves the run owns its own teardown, so a
        // post-launch failure (e.g. the read-back throwing) must NOT delete a
        // live run's workspace. Best-effort + idempotent.
        if (!launched) await deleteRunWorkspace(runId);
        throw err;
      }
    },
  );

  // GET /api/agents/:scope/:name/runs — list runs for an agent
  router.get(`/agents/${SCOPED_PACKAGE_ROUTE}/runs`, requireAgent(), async (c) => {
    const agent = c.get("package");
    const scope = getAppScope(c);
    const { limit, offset } = parseListPagination(c, { defaultLimit: 50 });
    const endUser = c.get("endUser");
    const result = await listPackageRuns(scope, agent.id, {
      limit,
      offset,
      endUserId: endUser?.id,
      actor: getActor(c),
    });
    setOffsetLinkHeader({ c, limit, offset, total: result.total });
    return c.json(result);
  });

  // GET /api/runs — global paginated run list across the application.
  // Supports filtering by ?user=me (self-owned runs), ?kind=inline|package|all
  // for inline-run filtering, ?status, ?start_date/?end_date, and
  // ?chat_session_id for the conversation context sidebar.
  //
  // `user`, `kind` and `status` are all closed sets and all go through
  // `closedSetQuery`: an unrecognised value is a 400, not a dropped filter.
  // `limit`/`offset` deliberately keep their `.catch()` defaults — a bad page
  // size returns the first page, which narrows rather than widens, and callers
  // paging by `Link` headers never construct them by hand.
  router.get("/runs", async (c) => {
    const actor = getActor(c);
    const scope = getAppScope(c);
    const { limit, offset } = parseListPagination(c, { defaultLimit: 20 });
    // `user` is a closed set of one: `me`. Validated BEFORE the end-user branch
    // below so the param means the same thing for every caller, instead of a
    // typo surviving in an end-user integration until it runs under an org
    // session.
    const userFilter = closedSetQuery(c, "user", USER_FILTERS);
    const endUser = c.get("endUser");

    // End-users always see only their own runs — same semantic as before.
    if (userFilter === "me" || endUser) {
      const result = await listUserRuns(scope, actor, { limit, offset });
      setOffsetLinkHeader({ c, limit, offset, total: result.total });
      return c.json(result);
    }

    const kind = closedSetQuery(c, "kind", GLOBAL_RUN_KINDS);
    const status = closedSetQuery(c, "status", runStatusValues);
    const startDateRaw = c.req.query("start_date");
    const endDateRaw = c.req.query("end_date");
    const chatSessionId = c.req.query("chat_session_id") || undefined;
    const startDate = startDateRaw ? new Date(startDateRaw) : undefined;
    const endDate = endDateRaw ? new Date(endDateRaw) : undefined;
    if (startDate && Number.isNaN(startDate.getTime())) {
      throw invalidRequest("start_date is not a valid ISO date", "start_date");
    }
    if (endDate && Number.isNaN(endDate.getTime())) {
      throw invalidRequest("end_date is not a valid ISO date", "end_date");
    }

    const result = await listGlobalRuns(scope, {
      limit,
      offset,
      kind,
      status,
      startDate,
      endDate,
      chatSessionId,
      actor,
    });
    setOffsetLinkHeader({ c, limit, offset, total: result.total });
    return c.json(result);
  });

  // GET /api/runs/:id — get a single run
  //
  // Optional `?wait=<seconds|true>` long-poll (issue #631): holds the
  // request until the run reaches a terminal status or the wait elapses
  // (capped at MAX_WAIT_SECONDS, below typical proxy idle timeouts), then
  // returns the run object exactly as the plain call does. A non-terminal
  // status in the response means "poll again". The wakeup is event-driven
  // (run_update PG NOTIFY) with a periodic DB re-check as fallback — see
  // services/run-wait.ts. Auth/scoping is identical to the plain call:
  // ownership is verified BEFORE any waiting starts.
  router.get("/runs/:id", async (c) => {
    const runId = c.req.param("id");
    const scope = getAppScope(c);
    // Validate the wait param before touching the DB so a malformed value
    // 400s even for runs the caller could not read.
    const waitMs = parseWaitQuery(c.req.query("wait"));

    const row = await getRunFull(scope, runId, getActor(c));
    if (!row) {
      throw notFound("Run not found");
    }
    const endUser = c.get("endUser");
    if (endUser && row.endUserId !== endUser.id) {
      throw notFound("Run not found");
    }

    if (waitMs > 0 && !TERMINAL_RUN_STATUSES.has(row.status)) {
      const apiKeyId = c.get("apiKeyId");
      await waitForRunTerminal({
        runId,
        scope,
        timeoutMs: waitMs,
        // Per-identity concurrent-waiter cap (same identity keying as the
        // rate-limit middleware). Beyond the cap the wait degrades to
        // no-wait: the fresh read below answers immediately and the
        // client's normal poll-again loop takes over. Documented in the
        // OpenAPI `wait` parameter.
        identity: apiKeyId ? `apikey:${apiKeyId}` : c.get("user").id,
        // Client disconnect aborts the server-side wait — no leaked
        // timers/subscriptions for a response nobody will read.
        signal: c.req.raw.signal,
      });
      const fresh = await getRunFull(scope, runId, getActor(c));
      // The run can be deleted mid-wait (e.g. DELETE agent runs) — surface
      // the same 404 the initial read would have.
      if (!fresh) {
        throw notFound("Run not found");
      }
      return c.json(fresh);
    }

    return c.json(row);
  });

  // GET /api/runs/:id/logs — get run logs
  //
  // Optional `?since=<bigint>` cursor returns rows with `id > since`. The
  // CLI's `runRemote` polling loop tracks the last id it rendered and
  // passes it back so each poll's payload is bounded by what's new since
  // the previous tick — without the cursor, the server returns the full
  // history on every poll and per-tick wire cost grows linearly with run
  // length. Invalid values (non-numeric, negative) are silently ignored
  // rather than 400'd: a stale or malformed cursor on a re-fetch must
  // never break the tail.
  //
  // Optional `?level=<debug|info|warn|error>` filters by MINIMUM severity
  // (`level=info` skips debug breadcrumbs). Optional `?limit=<1..1000>`
  // caps the page size — DEFAULT 1000 when omitted, so the endpoint is
  // never unbounded (a long run used to ship its entire history in one
  // response); when more rows follow, an RFC 5988
  // `Link: <…?since=<lastId>>; rel="next"` header points at the next page
  // — `since` doubles as both the polling-tail cursor and the pagination
  // cursor, so the two contracts cannot drift. All three params follow
  // the endpoint's lenient posture: malformed values fall back to the
  // default (for `limit`: 1000) rather than 400, because a stale cursor
  // or a typo'd filter on a re-fetch must never break the tail.
  //
  // Rate limited at 120/min per identity (same budget as the inbound MCP
  // server) — the log history can be large and the CLI tail polls it in a
  // loop, so an unmetered caller could turn this read into a DB hammer.
  router.get("/runs/:id/logs", rateLimit(120), async (c) => {
    const runId = c.req.param("id")!;
    const scope = getAppScope(c);
    const exec = await getRun(scope, runId);
    if (!exec) {
      throw notFound("Run not found");
    }
    const endUser = c.get("endUser");
    if (endUser && exec.endUserId !== endUser.id) {
      throw notFound("Run not found");
    }

    const sinceParam = c.req.query("since");
    let sinceId: number | undefined;
    if (sinceParam !== undefined && sinceParam !== "") {
      const parsed = Number(sinceParam);
      if (Number.isInteger(parsed) && parsed >= 0) sinceId = parsed;
    }

    const minLevel = z.enum(RUN_LOG_LEVELS).optional().catch(undefined).parse(c.req.query("level"));

    // Log pages are limit-only (`since` is the cursor), so the helper's
    // `offset` is dropped. The old inline form also carried a `.default(1000)`
    // ahead of `.catch(1000)`: dead, because `.catch` already absorbs the
    // `undefined` an absent `?limit=` produces.
    const { limit } = parseListPagination(c, { defaultLimit: 1000, maxLimit: 1000 });

    // Ownership was just verified via getRun(scope) above — we can hand
    // off to the org-scoped log reader safely. Over-fetch by one row so
    // `hasMore` is known without a COUNT round-trip.
    const rows = await listRunLogs({
      runId,
      orgId: scope.orgId,
      ...(sinceId !== undefined ? { sinceId } : {}),
      ...(minLevel !== undefined ? { minLevel } : {}),
      limit: limit + 1,
    });

    const hasMore = rows.length > limit;
    const logs = hasMore ? rows.slice(0, limit) : rows;
    setSinceLinkHeader({ c, hasMore, lastId: logs.at(-1)?.id });

    // Standard list envelope (`{ object: "list", data, hasMore }`) — same
    // wire shape as every other list endpoint. The RFC 5988 `Link` header
    // and the `since` cursor semantics are unchanged.
    return c.json(listResponse(logs, { hasMore }));
  });

  // POST /api/runs/:id/cancel — cancel a running/pending run
  //
  // Funnels through `synthesiseFinalize` so the cancellation traverses the
  // exact same terminal-state pipeline as success/timeout/fail: cost is
  // aggregated from `llm_usage`, the runner ledger row settles, and the
  // `run_completed` log row + `onRunStatusChange` broadcast happen exactly
  // once. Pre-fix, this route wrote `status='cancelled'` and closed the sink
  // directly — no terminal broadcast fired and the cloud module never debited
  // credits for cancelled runs that had already burned LLM tokens.
  router.post("/runs/:id/cancel", requirePermission("runs", "cancel"), async (c) => {
    const runId = c.req.param("id")!;
    const scope = getAppScope(c);

    const run = await getRun(scope, runId);
    if (!run) {
      throw notFound("Run not found");
    }

    // End-user boundary: `runs:cancel` is an OIDC-grantable end-user scope, but
    // an end-user must only cancel their OWN runs — mirror the ownership guard
    // the read paths (`GET /runs/:id`, `/logs`) apply. Scope alone (org+app) is
    // not enough here.
    const endUser = c.get("endUser");
    if (endUser && run.endUserId !== endUser.id) {
      throw notFound("Run not found");
    }

    // Verify cancellable
    if (run.status !== "pending" && run.status !== "running") {
      throw conflict("not_cancellable", "This run cannot be cancelled");
    }

    // Abort in-flight fetch calls + stop the workload and WAIT (bounded) for
    // the stop to ack BEFORE synthesising the terminal. Closing the sink /
    // writing the terminal while the workload still runs with live credentials
    // is a credential-exposure window; awaiting the stop closes it in the
    // common case. On a wedged runtime the helper times out and returns false,
    // and we still force-finalize (liveness) rather than leave the run stuck.
    abortRun(runId);
    const stopped = await stopWorkloadAndWait(runId);
    if (!stopped) {
      logger.warn("run cancel: workload stop unacknowledged, force-finalizing", { runId });
    }

    await synthesiseFinalize(runId, {
      status: "cancelled",
      error: { message: "Cancelled by user" },
    });

    await recordAuditFromContext(c, {
      action: "run.cancelled",
      resourceType: "run",
      resourceId: runId,
      before: { status: run.status },
      after: { status: "cancelled", packageId: run.packageId },
    });

    // Return the bare updated run resource — read AFTER synthesiseFinalize so
    // the response reflects the terminal state (`status: "cancelled"`, cost,
    // completed_at). Same DTO and serializer as GET /runs/:id (#657).
    const row = await getRunFull(scope, runId, getActor(c));
    if (!row) {
      // The run was readable above; a miss here means a concurrent delete
      // raced the finalize. The resource is gone — surface the same 404 a
      // fresh read would.
      throw notFound("Run not found");
    }
    return c.json(row);
  });

  // POST /api/runs/inline — execute an inline (no persisted package) agent.
  // See docs/specs/INLINE_RUNS.md. The manifest + prompt travel in the
  // request body; the platform creates a transient shadow package
  // (ephemeral = true), runs it through the existing pipeline, and
  // returns 201 + the bare created run resource (the shadow package id is
  // the run's `packageId` field). The client streams progress via
  // GET /api/realtime/runs/:id (existing SSE endpoint).
  router.post(
    "/runs/inline",
    // Dedicated rate limit — the cap is loaded from INLINE_RUN_LIMITS
    // each time the middleware is constructed. We read it at route-build
    // time; changes to the env require a reboot.
    rateLimit(getInlineRunLimits().rate_per_min),
    idempotency(),
    requirePermission("agents", "run"),
    async (c) => {
      const orgId = c.get("orgId");
      const applicationId = c.get("applicationId");
      const actor = getActor(c);

      // `rerun_from` is rejected by `inlineRunBodySchema` itself — see the field
      // note there. No second read of the body here.
      const body = await readJsonBody(c, inlineRunBodySchema);

      // Preflight BEFORE any input file streams — a bad manifest or
      // readiness problem 4xxes without touching storage.
      const preflight = await runInlinePreflight({ orgId, applicationId, actor, body });

      // ----- Context files (fan-in by reference) -----
      // Both entry paths land on ONE synthesized reserved input field, and the
      // synthesis must happen HERE: `parseRequestInput` below reads the input
      // schema off `preflight.manifest`, so the field has to be declared before
      // it walks the input. Everything after this block is the ordinary file
      // path — ACL (`getFileForActor`), byte + count caps, streaming into
      // `files/`, `file_links` — and the platform prompt announces the
      // mounted files exactly as it does for an uploaded file.
      assertContextFilesFieldAvailable(preflight.manifest, body.input);
      // B2 — the explicit argument. Shape-checked first: a malformed URI 400s
      // without spending a file lookup.
      const explicitFileUris = normalizeContextFileUris(body.context_files);
      const { manifest: effectiveManifest, inputPatch } = injectContextFiles(
        preflight.manifest,
        explicitFileUris,
      );
      const effectivePreflight = inputPatch
        ? { ...preflight, manifest: effectiveManifest }
        : preflight;

      // Same input machinery as POST /agents/:scope/:name/run: file fields
      // (`format: uri` + `contentMediaType`) resolve `upload://` /
      // `appfile://` / inline `data:` URIs through the container ACL + caps
      // and stream the bytes into this run's workspace. Minted before parsing
      // for the same reason as the agent route (files stream straight
      // into the run's workspace namespace).
      const runId = `run_${crypto.randomUUID()}`;
      // Flips true the instant `triggerInlineRun` launches the pipeline. Past
      // that point the run OWNS its workspace — a later failure (e.g. the
      // read-back below) must NOT delete a live run's input files.
      let launched = false;
      try {
        const parsed = await parseRequestInput(
          c,
          body,
          runId,
          effectiveManifest.input?.schema
            ? asJSONSchemaObject(effectiveManifest.input.schema)
            : undefined,
          { injectedInput: inputPatch },
        );

        const { packageId } = await triggerInlineRun({
          orgId,
          applicationId,
          actor,
          runId,
          preflight: effectivePreflight,
          parsed,
          apiKeyId: c.get("apiKeyId") ?? undefined,
          traceparent: runTraceparent(c),
        });
        // Pipeline launched — the run now owns its workspace teardown.
        launched = true;

        await recordAuditFromContext(c, {
          action: "run.triggered",
          resourceType: "run",
          resourceId: runId,
          after: { packageId, origin: "inline" },
        });

        // 201 + the bare created run resource (#657) — same DTO and serializer
        // as GET /runs/:id, same status code as the sibling trigger
        // POST /agents/{scope}/{name}/run. The shadow package id callers used
        // to read from the `packageId` envelope field is the resource's own
        // `packageId`. The run row exists once `triggerInlineRun` resolves
        // (`prepareAndExecuteRun` inserts it before returning).
        const row = await getRunFull(getAppScope(c), runId, getActor(c));
        if (!row) {
          // The shadow run was inserted by `triggerInlineRun` and read back on
          // the same scope; a miss means a concurrent teardown deleted it. The
          // 201 contract is the full `Run`, so surface a 500 rather than a
          // partial id-only body that would lie to the typed client.
          // Effectively unreachable in normal operation.
          throw internalError();
        }
        return c.json(row, 201);
      } catch (err) {
        // Roll back any input files streamed into the run workspace before
        // the run launched — same pre-launch teardown as the agent route. Once
        // `triggerInlineRun` has launched the pipeline the run owns its own
        // teardown, so a post-launch failure must NOT delete its workspace.
        if (!launched) await deleteRunWorkspace(runId);
        throw err;
      }
    },
  );

  // POST /api/runs/inline/validate — dry-run validator for inline manifests.
  // Runs the full preflight (manifest + input + agent readiness)
  // WITHOUT inserting a shadow package or firing a pipeline. Lets developers
  // iterate on a manifest without creating phantom runs or burning credits.
  // Shares 100% of its validation with POST /api/runs/inline via
  // runInlinePreflight().
  //
  // NOTE: intentionally shares the SAME rate-limit bucket as /runs/inline
  // (method+path+identity → different key, same rate_per_min cap). Validation
  // exercises the same readiness / AJV machinery as an actual run,
  // so guarding against tight validation loops matters. Documented in the
  // OpenAPI description.
  router.post(
    "/runs/inline/validate",
    rateLimit(getInlineRunLimits().rate_per_min),
    requirePermission("agents", "run"),
    async (c) => {
      const orgId = c.get("orgId");
      const applicationId = c.get("applicationId");
      const actor = getActor(c);
      const body = await readJsonBody(c, inlineRunBodySchema);

      await runInlinePreflight({ orgId, applicationId, actor, body, mode: "accumulate" });
      // Same reserved-name rule as the run endpoint — a manifest that validates
      // here must be runnable there.
      assertContextFilesFieldAvailable(body.manifest, body.input);
      normalizeContextFileUris(body.context_files);

      // Structured validation result. Failures never reach this line — the
      // preflight throws problem+json ApiErrors (accumulated) — so a 200
      // always means `valid: true`; the shape leaves room for non-fatal
      // detail (warnings) later without another wire break.
      return c.json({ valid: true });
    },
  );

  // DELETE /api/agents/:scope/:name/runs — delete all runs for an agent
  router.delete(
    `/agents/${SCOPED_PACKAGE_ROUTE}/runs`,
    requireAgent(),
    requirePermission("runs", "delete"),
    async (c) => {
      const agent = c.get("package");
      const scope = getAppScope(c);

      const running = await getRunningRunsForPackage(scope, agent.id);
      if (running > 0) {
        throw conflict("run_in_progress", `${running} run(s) still running`);
      }

      const deleted = await deletePackageRuns(scope, agent.id);
      await recordAuditFromContext(c, {
        action: "agent.runs_bulk_deleted",
        resourceType: "agent",
        resourceId: agent.id,
        after: { deletedCount: deleted },
      });
      return c.json({ deleted_count: deleted });
    },
  );

  return router;
}
