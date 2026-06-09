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
  listRunLogs,
  RUN_LOG_LEVELS,
} from "../services/state/runs.ts";
import { getVersionDetail } from "../services/package-versions.ts";
import { parseRequestInput } from "../services/input-parser.ts";
import { deleteRunWorkspace } from "../services/run-workspace-storage.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { mergeAndValidateConfigOverride } from "../services/agent-readiness.ts";
import { abortRun } from "../services/run-tracker.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { idempotency } from "../middleware/idempotency.ts";
import { notFound, conflict } from "../lib/errors.ts";
import { setOffsetLinkHeader, setSinceLinkHeader } from "../lib/pagination-link.ts";
import { requireAgent } from "../middleware/guards.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getOrchestrator } from "../services/orchestrator/index.ts";
import { prepareAndExecuteRun, resolveRunPreflight } from "../services/run-pipeline.ts";
import { assertExplicitModelExists } from "../services/org-models.ts";
import { resolveRunnerContext } from "../lib/runner-context.ts";
import { getActor } from "../lib/actor.ts";
import { getAppScope } from "../lib/scope.ts";
import { getInlineRunLimits } from "../services/run-limits.ts";
import { triggerInlineRun, type InlineRunBody } from "../services/inline-run.ts";
import { runInlinePreflight } from "../services/inline-run-preflight.ts";
import { synthesiseFinalize } from "../services/run-event-ingestion.ts";
import { getEnv } from "@appstrate/env";
import { currentTraceparent } from "../observability/index.ts";

/**
 * Resolve the traceparent to seed the run-execution trace tree with, honoring
 * the same anti-spoof gate as the SERVER span. When `OTEL_TRUST_INCOMING_TRACE`
 * is on we adopt the caller-supplied inbound header; when off we never trust it
 * — we fall back to the in-process SERVER span (via `currentTraceparent()`) so
 * the run spans stay in THIS process's trace instead of the unverified inbound
 * one. Returns `undefined` when observability is disabled or no span is active,
 * which makes the run span a fresh root (a no-op when telemetry is off).
 */
export function runTraceparent(c: Context<AppEnv>): string | undefined {
  return getEnv().OTEL_TRUST_INCOMING_TRACE ? c.get("traceparent") : currentTraceparent();
}

// --- Router ---

export function createRunsRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/agents/:scope/:name/run — execute an agent (fire-and-forget, returns JSON)
  router.post(
    "/agents/:scope{@[^/]+}/:name/run",
    rateLimit(20),
    idempotency(),
    requireAgent(),
    requirePermission("agents", "run"),
    async (c) => {
      const agent = c.get("package");
      const orgId = c.get("orgId");
      const actor = getActor(c);
      // Version override from query param (e.g. ?version=1.2.0 or ?version=latest)
      const versionOverride = c.req.query("version");

      // If a specific version is requested, resolve and override agent data
      let effectiveAgent = agent;
      let overrideVersionLabel: string | undefined;
      if (versionOverride && agent.source !== "system") {
        const versionDetail = await getVersionDetail(agent.id, versionOverride);
        if (!versionDetail) {
          throw notFound(`Version '${versionOverride}' not found`);
        }
        overrideVersionLabel = versionDetail.version;
        // Override manifest and content — version manifest replaces draft entirely
        effectiveAgent = {
          ...agent,
          manifest: versionDetail.manifest as typeof agent.manifest,
          prompt: versionDetail.prompt ?? agent.prompt,
        };
      }

      // Single canonical prefix — `run_` — shared with inline + remote origins.
      // Minted BEFORE input parsing so input documents can be streamed straight
      // into this run's workspace namespace during consume (no buffering them in
      // API memory until the run row exists). The run row is still created later
      // with this same id.
      const runId = `run_${crypto.randomUUID()}`;

      try {
        const inputResult = await parseRequestInput(
          c,
          runId,
          effectiveAgent.manifest.input?.schema
            ? asJSONSchemaObject(effectiveAgent.manifest.input.schema)
            : undefined,
        );

        const {
          input: parsedInput,
          uploadedFiles,
          modelIdOverride,
          proxyIdOverride,
          configOverride,
          connectionOverrides,
        } = inputResult;

        // An explicit per-run `modelId` override must reference a real model
        // (system key or org-model UUID). Reject unknown/malformed values with a
        // clean 404 rather than letting them silently fall through to the org
        // default downstream (or crash the uuid cast — see loadModel).
        await assertExplicitModelExists(orgId, modelIdOverride);

        // Shared preflight: resolve config, validate readiness. Threading
        // `connectionOverrides` here is what makes the
        // MissingConnectionsModal retry actually work — readiness sees the
        // caller's pick and skips the must_choose error on >1 candidates.
        // Pre-fix, the readiness gate fired must_choose regardless of the
        // override, so the picker UX loop never exited.
        const {
          config,
          modelId: preflightModelId,
          proxyId: preflightProxyId,
        } = await resolveRunPreflight({
          agent: effectiveAgent,
          applicationId: c.get("applicationId"),
          orgId,
          actor,
          connectionOverrides: connectionOverrides ?? null,
        });

        // Deep-merge any per-run `config` override on top of the persisted
        // application config and re-validate against the manifest schema.
        // Single helper shared with the scheduler so both paths converge to
        // an identical resolved config for the same `(persisted, override)`.
        const mergedConfig = mergeAndValidateConfigOverride(effectiveAgent, config, configOverride);

        const runner = await resolveRunnerContext(c);
        await prepareAndExecuteRun({
          runId,
          agent: effectiveAgent,
          orgId,
          actor,
          input: parsedInput,
          // File metadata for prompt context — the document bytes were already
          // streamed into the run workspace during consume.
          files: uploadedFiles,
          config: mergedConfig,
          configOverride: configOverride ?? null,
          modelId: modelIdOverride ?? preflightModelId,
          proxyId: proxyIdOverride ?? preflightProxyId,
          overrideVersionLabel,
          applicationId: c.get("applicationId"),
          apiKeyId: c.get("apiKeyId") ?? undefined,
          connectionOverrides: connectionOverrides ?? null,
          traceparent: runTraceparent(c),
          runnerName: runner.name,
          runnerKind: runner.kind,
        });

        return c.json({ runId });
      } catch (err) {
        // Roll back any input documents streamed into the run workspace before
        // the run launched (size/MIME mismatch, failed preflight, …). Once
        // `prepareAndExecuteRun` resolves the run owns its own teardown, so this
        // only fires on the pre-launch error path. Best-effort + idempotent.
        await deleteRunWorkspace(runId);
        throw err;
      }
    },
  );

  // GET /api/agents/:scope/:name/runs — list runs for an agent
  router.get("/agents/:scope{@[^/]+}/:name/runs", requireAgent(), async (c) => {
    const agent = c.get("package");
    const scope = getAppScope(c);
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .catch(50)
      .parse(c.req.query("limit") ?? 50);
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .catch(0)
      .parse(c.req.query("offset") ?? 0);
    const endUser = c.get("endUser");
    const result = await listPackageRuns(scope, agent.id, {
      limit,
      offset,
      endUserId: endUser?.id,
    });
    setOffsetLinkHeader({ c, limit, offset, total: result.total });
    return c.json(result);
  });

  // GET /api/runs — served by the notifications router (registered first
  // in index.ts so `/runs` matches the collection, not the {id} detail).
  // See apps/api/src/routes/notifications.ts.

  // GET /api/runs/:id — get a single run
  router.get("/runs/:id", async (c) => {
    const runId = c.req.param("id");
    const scope = getAppScope(c);
    const row = await getRunFull(scope, runId);
    if (!row) {
      throw notFound("Run not found");
    }
    const endUser = c.get("endUser");
    if (endUser && row.endUserId !== endUser.id) {
      throw notFound("Run not found");
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
  // caps the page size; when more rows follow, an RFC 5988
  // `Link: <…?since=<lastId>>; rel="next"` header points at the next page
  // — `since` doubles as both the polling-tail cursor and the pagination
  // cursor, so the two contracts cannot drift. All three params follow
  // the endpoint's lenient posture: malformed values fall back to the
  // unfiltered default rather than 400, because a stale cursor or a
  // typo'd filter on a re-fetch must never break the tail. Default
  // behavior (no params) is unchanged: the full chronological history.
  router.get("/runs/:id/logs", async (c) => {
    const runId = c.req.param("id");
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

    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .catch(undefined)
      .parse(c.req.query("limit"));

    // Ownership was just verified via getRun(scope) above — we can hand
    // off to the org-scoped log reader safely. Over-fetch by one row when
    // a limit is set so `hasMore` is known without a COUNT round-trip.
    const rows = await listRunLogs({
      runId,
      orgId: scope.orgId,
      ...(sinceId !== undefined ? { sinceId } : {}),
      ...(minLevel !== undefined ? { minLevel } : {}),
      ...(limit !== undefined ? { limit: limit + 1 } : {}),
    });

    const hasMore = limit !== undefined && rows.length > limit;
    const logs = hasMore ? rows.slice(0, limit) : rows;
    setSinceLinkHeader({ c, hasMore, lastId: logs.at(-1)?.id });

    return c.json(logs);
  });

  // POST /api/runs/:id/cancel — cancel a running/pending run
  //
  // Funnels through `synthesiseFinalize` so the cancellation traverses the
  // exact same terminal-state pipeline as success/timeout/fail: cost is
  // aggregated from `llm_usage`, `afterRun` fires (billing in cloud, …),
  // the `run_completed` log row + `onRunStatusChange` broadcast happen
  // exactly once. Pre-fix, this route wrote `status='cancelled'` and closed
  // the sink directly — `afterRun` was never called and the cloud module
  // never debited credits for cancelled runs that had already burned LLM
  // tokens.
  router.post("/runs/:id/cancel", requirePermission("runs", "cancel"), async (c) => {
    const runId = c.req.param("id")!;
    const scope = getAppScope(c);

    const run = await getRun(scope, runId);
    if (!run) {
      throw notFound("Run not found");
    }

    // Verify cancellable
    if (run.status !== "pending" && run.status !== "running") {
      throw conflict("not_cancellable", "This run cannot be cancelled");
    }

    // Abort in-flight fetch calls + stop the container BEFORE synthesising
    // the terminal so the runner stops emitting metric events and the
    // sidecar can be reclaimed promptly. `finalizeRun` then drains any
    // events that landed before this point, computes the authoritative
    // cost from `llm_usage`, and writes the terminal state under CAS.
    abortRun(runId);
    getOrchestrator()
      .stopByRunId(runId)
      .catch(() => {});

    await synthesiseFinalize(runId, {
      status: "cancelled",
      error: { message: "Cancelled by user" },
    });

    return c.json({ ok: true });
  });

  // POST /api/runs/inline — execute an inline (no persisted package) agent.
  // See docs/specs/INLINE_RUNS.md. The manifest + prompt travel in the
  // request body; the platform creates a transient shadow package
  // (ephemeral = true), runs it through the existing pipeline, and
  // returns 202 { runId } immediately. The client streams progress via
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

      const body = await c.req.json<InlineRunBody>();

      const { runId, packageId } = await triggerInlineRun({
        orgId,
        applicationId,
        actor,
        body,
        apiKeyId: c.get("apiKeyId") ?? undefined,
        traceparent: runTraceparent(c),
      });

      c.status(202);
      return c.json({ runId, packageId });
    },
  );

  // POST /api/runs/inline/validate — dry-run validator for inline manifests.
  // Runs the full preflight (manifest + config + input + agent readiness)
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
      const body = await c.req.json<InlineRunBody>();

      await runInlinePreflight({ orgId, applicationId, actor, body, mode: "accumulate" });

      return c.json({ ok: true });
    },
  );

  // DELETE /api/agents/:scope/:name/runs — delete all runs for an agent
  router.delete(
    "/agents/:scope{@[^/]+}/:name/runs",
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
      return c.json({ deleted });
    },
  );

  return router;
}
