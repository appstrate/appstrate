// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { Hono } from "hono";
import { logger } from "../lib/logger.ts";
import type { LoadedPackage, AppEnv } from "../types/index.ts";
import {
  updateRun,
  appendRunLog,
  getRun,
  getRunFull,
  getRunningRunsForPackage,
  deletePackageRuns,
  listPackageRuns,
  listRunLogs,
} from "../services/state/index.ts";
import { resolveActorProfileContext, getAgentAppProfile } from "../services/connection-profiles.ts";
import type { AppstrateRunPlan, UploadedFile } from "../services/adapters/types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import { runPlatformContainer } from "../services/adapters/pi.ts";
import type { PlatformContainerResult } from "../services/adapters/pi.ts";
import type { ContainerOrchestrator } from "../services/orchestrator/index.ts";
import { emptyRunResult, type RunResult } from "@appstrate/afps-runtime/runner";
import { getVersionDetail } from "../services/package-versions.ts";
import { parseRequestInput } from "../services/input-parser.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { mergeAndValidateConfigOverride } from "../services/agent-readiness.ts";
import { trackRun, untrackRun, abortRun } from "../services/run-tracker.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { idempotency } from "../middleware/idempotency.ts";
import { ApiError, notFound, conflict } from "../lib/errors.ts";
import { setOffsetLinkHeader } from "../lib/pagination-link.ts";
import { requireAgent } from "../middleware/guards.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getOrchestrator } from "../services/orchestrator/index.ts";
import { emitEvent } from "../lib/modules/module-loader.ts";
import { prepareAndExecuteRun, resolveRunPreflight } from "../services/run-pipeline.ts";
import { resolveRunnerContext } from "../lib/runner-context.ts";
import { getActor } from "../lib/actor.ts";
import { getAppScope } from "../lib/scope.ts";
import { getInlineRunLimits } from "../services/run-limits.ts";
import {
  triggerInlineRun,
  isInlineShadowPackageId,
  type InlineRunBody,
} from "../services/inline-run.ts";
import { runInlinePreflight } from "../services/inline-run-preflight.ts";
import { finalizeRun, getRunSinkContext } from "../services/run-event-ingestion.ts";
import type { SinkCredentials } from "../lib/mint-sink-credentials.ts";

// --- Background run (decoupled from client) ---

export interface ExecuteAgentInBackgroundInput {
  runId: string;
  orgId: string;
  applicationId: string;
  agent: LoadedPackage;
  context: ExecutionContext;
  plan: AppstrateRunPlan;
  agentPackage?: Buffer | null;
  inputFiles?: UploadedFile[];
  modelSource?: string | null;
  /** Sink credentials minted by `run-pipeline.ts` and persisted on the run row. */
  sinkCredentials: SinkCredentials;
  /**
   * Injectable orchestrator — production leaves this unset and the
   * global singleton drives Docker. Tests inject a fake orchestrator to
   * exercise the lifecycle without a real container runtime.
   */
  orchestrator?: ContainerOrchestrator;
}

/**
 * Drive a platform-origin container through its lifecycle. This function is
 * pure orchestration — no DB writes beyond the initial `running` flip + the
 * terminal synthesis when the container doesn't finalise itself.
 *
 * All event + state persistence happens inside the container (via
 * {@link HttpSink}) or inside {@link finalizeRun} (the convergence
 * point). The only state this function owns is the in-process abort
 * controller used to propagate user-triggered cancellation to the
 * Docker workload.
 */
export async function executeAgentInBackground(
  input: ExecuteAgentInBackgroundInput,
): Promise<void> {
  const {
    runId,
    orgId,
    applicationId,
    agent,
    context,
    plan,
    agentPackage,
    inputFiles,
    modelSource,
    sinkCredentials,
  } = input;

  const scope = { orgId, applicationId };
  const startTime = Date.now();
  const controller = trackRun(runId);
  const { signal } = controller;
  const packageEphemeral = isInlineShadowPackageId(agent.id);

  try {
    // Status flip — pending → running — is the ONE lifecycle transition
    // the platform still owns (the container can't authoritatively
    // announce itself running because it doesn't know when the server
    // actually accepted its first event). Everything terminal flows
    // through finalizeRun.
    await updateRun(scope, runId, { status: "running" });
    void emitEvent("onRunStatusChange", {
      orgId,
      runId,
      packageId: agent.id,
      applicationId,
      status: "started",
      packageEphemeral,
      ...(modelSource ? { modelSource } : {}),
    });

    const runPlan: AppstrateRunPlan = {
      ...plan,
      agentPackage: agentPackage ?? undefined,
      inputFiles,
    };

    let lifecycle: PlatformContainerResult;
    try {
      lifecycle = await runPlatformContainer({
        runId,
        context,
        plan: runPlan,
        sinkCredentials,
        signal,
        ...(input.orchestrator ? { orchestrator: input.orchestrator } : {}),
      });
    } catch (err) {
      // Orchestrator-level failure (Docker unreachable, image missing, ...)
      // before the container even exited. Cancel case is handled below in
      // the `finally` — we only synthesise a terminal failure here for
      // genuine infrastructure errors.
      if (signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      logger.error("runPlatformContainer threw — synthesising failed terminal", {
        runId,
        error: message,
      });
      await synthesiseFinalize(runId, {
        status: "failed",
        error: { message, stack: err instanceof Error ? err.stack : undefined },
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // Container exited normally. If it finalised itself over HTTP, our
    // synthesis is a CAS no-op. If it didn't (crash, timeout, cancel),
    // we fill in the terminal state the platform observed.
    if (lifecycle.cancelled) {
      // Cancel route already wrote status + closed the sink — nothing to do.
      return;
    }

    if (lifecycle.timedOut) {
      await synthesiseFinalize(runId, {
        status: "timeout",
        error: { message: `Run timed out after ${plan.timeout}s` },
        durationMs: Date.now() - startTime,
      });
      return;
    }

    if (lifecycle.exitCode !== 0) {
      await synthesiseFinalize(runId, {
        status: "failed",
        error: {
          message: `Agent container exited with code ${lifecycle.exitCode}`,
        },
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // Exit code 0 — the container ran to completion and should have
    // called finalize itself. Defensively synthesise success so a
    // container that forgot to finalise still reaches a terminal state;
    // the CAS makes this a no-op when the container did call finalize.
    await synthesiseFinalize(runId, {
      status: "success",
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    if (signal.aborted) return;
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.error("Unhandled error in executeAgentInBackground", { runId, error: message });
    await synthesiseFinalize(runId, {
      status: "failed",
      error: { message, stack: err instanceof Error ? err.stack : undefined },
      durationMs: Date.now() - startTime,
    });
  } finally {
    untrackRun(runId);
  }
}

/**
 * Re-enter `finalizeRun` with a terminal result synthesised by the
 * platform. Idempotent by design: the CAS on `sink_closed_at IS NULL`
 * inside `finalizeRun` makes this a no-op if the container already
 * posted its own finalize.
 */
async function synthesiseFinalize(
  runId: string,
  terminal: {
    status: "success" | "failed" | "timeout" | "cancelled";
    error?: { message: string; stack?: string };
    durationMs?: number;
  },
): Promise<void> {
  const run = await getRunSinkContext(runId);
  if (!run) {
    logger.error("synthesiseFinalize: run sink context missing", { runId });
    return;
  }

  const result: RunResult = emptyRunResult();
  result.status = terminal.status;
  if (terminal.error) result.error = terminal.error;
  if (terminal.durationMs !== undefined) result.durationMs = terminal.durationMs;

  await finalizeRun({
    run,
    result,
    webhookId: `synthesized-${runId}`,
  });
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
      const agent = c.get("agent");
      const orgId = c.get("orgId");
      const actor = getActor(c);
      const packageId = agent.id;
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
          prompt: versionDetail.textContent ?? agent.prompt,
        };
      }

      // Resolve app profile, actor profile context, and input in parallel
      const [agentAppProfile, { defaultUserProfileId, userProviderOverrides }, inputResult] =
        await Promise.all([
          getAgentAppProfile({ orgId, applicationId: c.get("applicationId")! }, packageId),
          resolveActorProfileContext(actor, packageId, null, c.get("applicationId")!),
          parseRequestInput(
            c,
            effectiveAgent.manifest.input?.schema
              ? asJSONSchemaObject(effectiveAgent.manifest.input.schema)
              : undefined,
          ),
        ]);

      // Shared preflight: resolve providers, config, validate readiness
      const {
        providerProfiles,
        config,
        modelId: preflightModelId,
        proxyId: preflightProxyId,
      } = await resolveRunPreflight({
        agent: effectiveAgent,
        applicationId: c.get("applicationId"),
        orgId,
        defaultUserProfileId,
        userProviderOverrides,
        appProfileId: agentAppProfile?.id ?? null,
      });

      const {
        input: parsedInput,
        uploadedFiles,
        modelIdOverride,
        proxyIdOverride,
        configOverride,
      } = inputResult;

      // Deep-merge any per-run `config` override on top of the persisted
      // application config and re-validate against the manifest schema.
      // Single helper shared with the scheduler so both paths converge to
      // an identical resolved config for the same `(persisted, override)`.
      const mergedConfig = mergeAndValidateConfigOverride(effectiveAgent, config, configOverride);

      // Single canonical prefix — `run_` — shared with inline + remote
      // origins. The legacy `exec_` prefix was a platform-only relic from
      // before the unified runner protocol.
      const runId = `run_${crypto.randomUUID()}`;

      // Build file metadata for prompt context (no URLs — files injected directly into container)
      const fileRefs = uploadedFiles?.map((f) => ({
        fieldName: f.fieldName,
        name: f.name,
        type: f.type,
        size: f.size,
      }));

      const runner = await resolveRunnerContext(c);
      const result = await prepareAndExecuteRun({
        runId,
        agent: effectiveAgent,
        providerProfiles,
        orgId,
        actor,
        input: parsedInput,
        files: fileRefs,
        config: mergedConfig,
        configOverride: configOverride ?? null,
        modelId: modelIdOverride ?? preflightModelId,
        modelOverridden: modelIdOverride != null,
        proxyId: proxyIdOverride ?? preflightProxyId,
        proxyOverridden: proxyIdOverride != null,
        overrideVersionLabel,
        versionOverridden: overrideVersionLabel != null,
        connectionProfileId: defaultUserProfileId ?? undefined,
        applicationId: c.get("applicationId"),
        uploadedFiles,
        apiKeyId: c.get("apiKeyId") ?? undefined,
        traceparent: c.get("traceparent"),
        runnerName: runner.name,
        runnerKind: runner.kind,
      });

      if (!result.ok) {
        const { error } = result;
        if (error.code === "model_not_configured") {
          throw new ApiError({
            status: 400,
            code: "model_not_configured",
            title: "Bad Request",
            detail: error.message,
          });
        }
        // Module rejections (beforeRun hook) carry a status hint
        if ("status" in error && typeof error.status === "number") {
          throw new ApiError({
            status: error.status,
            code: error.code,
            title: error.message,
            detail: error.message,
          });
        }
        throw new Error(error.message);
      }

      return c.json({ runId });
    },
  );

  // GET /api/agents/:scope/:name/runs — list runs for an agent
  router.get("/agents/:scope{@[^/]+}/:name/runs", requireAgent(), async (c) => {
    const agent = c.get("agent");
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

    // Ownership was just verified via getRun(scope) above — we can hand
    // off to the org-scoped log reader safely.
    const logs = await listRunLogs({
      runId,
      orgId: scope.orgId,
      ...(sinceId !== undefined ? { sinceId } : {}),
    });

    return c.json(logs);
  });

  // POST /api/runs/:id/cancel — cancel a running/pending run
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

    // Update DB + close the signed-event sink atomically — any in-flight
    // event POST from the container will now reject with 410 gone, and
    // `finalizeRun`'s CAS makes server-side synthesis a no-op.
    const now = new Date().toISOString();
    await updateRun(scope, runId, {
      status: "cancelled",
      error: "Cancelled by user",
      completedAt: now,
      notifiedAt: now,
      sinkClosedAt: now,
    });

    // Log the cancellation
    await appendRunLog(
      scope,
      runId,
      "system",
      "run_completed",
      null,
      {
        runId,
        status: "cancelled",
      },
      "info",
    );

    // Abort in-flight fetch calls immediately, then stop the container as backup
    abortRun(runId);
    getOrchestrator()
      .stopByRunId(runId)
      .catch(() => {});

    void emitEvent("onRunStatusChange", {
      orgId: scope.orgId,
      runId,
      packageId: run.packageId,
      applicationId: scope.applicationId,
      status: "cancelled",
      packageEphemeral: isInlineShadowPackageId(run.packageId),
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
        traceparent: c.get("traceparent"),
      });

      c.status(202);
      return c.json({ runId, packageId });
    },
  );

  // POST /api/runs/inline/validate — dry-run validator for inline manifests.
  // Runs the full preflight (manifest + config + input + provider readiness)
  // WITHOUT inserting a shadow package or firing a pipeline. Lets developers
  // iterate on a manifest without creating phantom runs or burning credits.
  // Shares 100% of its validation with POST /api/runs/inline via
  // runInlinePreflight().
  //
  // NOTE: intentionally shares the SAME rate-limit bucket as /runs/inline
  // (method+path+identity → different key, same rate_per_min cap). Validation
  // exercises the same provider-resolution / AJV machinery as an actual run,
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
      const agent = c.get("agent");
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
