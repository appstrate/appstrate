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
  addPackageMemories,
} from "../services/state/index.ts";
import { resolveActorProfileContext, getAgentAppProfile } from "../services/connection-profiles.ts";
import { PiAdapter, TimeoutError } from "../services/adapters/index.ts";
import type { AppstrateRunPlan, UploadedFile } from "../services/adapters/types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import { AppstrateEventSink } from "../services/adapters/appstrate-event-sink.ts";
import { AppstrateContainerRunner } from "../services/adapters/appstrate-container-runner.ts";
import { loadBundleFromBuffer, type LoadedBundle } from "@appstrate/afps-runtime/bundle";
import type { ProviderResolver } from "@appstrate/afps-runtime/resolvers";
import { getVersionDetail } from "../services/package-versions.ts";
import { validateOutput } from "../services/schema.ts";
import { parseRequestInput } from "../services/input-parser.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { trackRun, untrackRun, abortRun } from "../services/run-tracker.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { idempotency } from "../middleware/idempotency.ts";
import { ApiError, notFound, conflict } from "../lib/errors.ts";
import { requireAgent } from "../middleware/guards.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getOrchestrator } from "../services/orchestrator/index.ts";
import { callHook, emitEvent } from "../lib/modules/module-loader.ts";
import type { RunStatusChangeParams } from "@appstrate/core/module";
import { prepareAndExecuteRun, resolveRunPreflight } from "../services/run-pipeline.ts";
import { getActor } from "../lib/actor.ts";
import { getAppScope } from "../lib/scope.ts";
import { getInlineRunLimits } from "../services/run-limits.ts";
import {
  insertShadowPackage,
  buildShadowLoadedPackage,
  deleteOrphanShadowPackage,
  isInlineShadowPackageId,
} from "../services/inline-run.ts";
import { runInlinePreflight, type InlineRunBody } from "../services/inline-run-preflight.ts";

/**
 * Build a {@link LoadedBundle} for the Runner contract. When the route
 * already has the packaged ZIP (produced by `buildAgentPackage`), we
 * parse it via the runtime loader so the shape matches what an external
 * consumer would see. Otherwise we synthesise a minimal bundle from the
 * in-memory agent — sufficient for the contract since
 * AppstrateContainerRunner delegates execution to the Pi container,
 * which reads the bundle from `/workspace/agent-package.afps`.
 */
async function buildRunnerBundle(
  agent: LoadedPackage,
  agentPackage: Buffer | null,
): Promise<LoadedBundle> {
  if (agentPackage) {
    return loadBundleFromBuffer(agentPackage);
  }
  const encoder = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    "manifest.json": encoder.encode(JSON.stringify(agent.manifest, null, 2)),
    "prompt.md": encoder.encode(agent.prompt),
  };
  return {
    manifest: agent.manifest as Record<string, unknown>,
    prompt: agent.prompt,
    files,
    compressedSize: 0,
    decompressedSize: Object.values(files).reduce((acc, buf) => acc + buf.byteLength, 0),
  };
}

async function collectAfterRunMetadata(
  params: RunStatusChangeParams,
): Promise<Record<string, unknown> | null> {
  try {
    return (await callHook("afterRun", params)) ?? null;
  } catch (err) {
    logger.error("afterRun hook failed — run record will be missing metadata", {
      err: err instanceof Error ? err.message : String(err),
      orgId: params.orgId,
      runId: params.runId,
    });
    return null;
  }
}

// --- Background run (decoupled from client) ---

export async function executeAgentInBackground(
  runId: string,
  orgId: string,
  agent: LoadedPackage,
  context: ExecutionContext,
  plan: AppstrateRunPlan,
  applicationId: string,
  agentPackage?: Buffer | null,
  inputFiles?: UploadedFile[],
  modelSource?: string | null,
) {
  const scope = { orgId, applicationId };
  const startTime = Date.now();
  const controller = trackRun(runId);
  const { signal } = controller;
  // Derived once — cheap string test used to decorate every lifecycle event.
  const packageEphemeral = isInlineShadowPackageId(agent.id);
  const sink = new AppstrateEventSink({ scope, runId });

  try {
    // Update status to running
    await updateRun(scope, runId, { status: "running" });
    void emitEvent("onRunStatusChange", {
      orgId,
      runId,
      packageId: agent.id,
      applicationId,
      status: "started",
      packageEphemeral,
    });

    const runner = new AppstrateContainerRunner({
      adapter: new PiAdapter(),
      plan: {
        ...plan,
        agentPackage: agentPackage ?? undefined,
        inputFiles,
      },
    });

    const bundle = await buildRunnerBundle(agent, agentPackage ?? null);
    const providerResolver: ProviderResolver = { resolve: async () => [] };

    try {
      await runner.run({
        bundle,
        context,
        providerResolver,
        eventSink: sink,
        signal,
      });
    } catch (err) {
      if (signal.aborted) {
        // Cancelled by user — cancel route already wrote DB status
        return;
      }
      if (err instanceof TimeoutError) {
        const duration = Date.now() - startTime;
        const totalTokens = sink.current.usage.input_tokens + sink.current.usage.output_tokens;
        const metadata = await collectAfterRunMetadata({
          orgId,
          runId,
          packageId: agent.id,
          applicationId,
          status: "timeout",
          cost: sink.current.cost,
          duration,
          modelSource: modelSource ?? null,
        });
        await updateRun(scope, runId, {
          status: "timeout",
          error: `Run timed out after ${plan.timeout}s`,
          completedAt: new Date().toISOString(),
          duration,
          notifiedAt: new Date().toISOString(),
          ...(totalTokens > 0
            ? {
                tokenUsage: { ...sink.current.usage } as Record<string, unknown>,
              }
            : {}),
          ...(metadata ? { metadata } : {}),
        });
        await appendRunLog(
          scope,
          runId,
          "system",
          "run_completed",
          null,
          {
            runId,
            status: "timeout",
          },
          "error",
        );
        void emitEvent("onRunStatusChange", {
          orgId,
          runId,
          packageId: agent.id,
          applicationId,
          status: "timeout",
          cost: sink.current.cost,
          duration,
          modelSource: modelSource ?? null,
          packageEphemeral,
        });
        return;
      }
      throw err;
    }

    // Determine outcome: fail only on adapter error or zero tokens (LLM unreachable).
    // An agent without the output tool succeeds even without structured output.
    const totalTokens = sink.current.usage.input_tokens + sink.current.usage.output_tokens;
    const error =
      sink.current.lastAdapterError ??
      (totalTokens === 0
        ? plan.proxyUrl
          ? "The AI agent could not reach the LLM API — the configured proxy may be unreachable or rejecting connections"
          : "The AI agent could not reach the LLM API — check that the API key is valid and the provider is accessible"
        : null);

    if (signal.aborted) return;

    const duration = Date.now() - startTime;

    if (error) {
      const metadata = await collectAfterRunMetadata({
        orgId,
        runId,
        packageId: agent.id,
        applicationId,
        status: "failed",
        cost: sink.current.cost,
        duration,
        modelSource: modelSource ?? null,
      });
      await updateRun(scope, runId, {
        status: "failed",
        error,
        completedAt: new Date().toISOString(),
        duration,
        notifiedAt: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
      });
      await appendRunLog(
        scope,
        runId,
        "system",
        "run_completed",
        null,
        { runId, status: "failed", error },
        "error",
      );
      void emitEvent("onRunStatusChange", {
        orgId,
        runId,
        packageId: agent.id,
        applicationId,
        status: "failed",
        cost: sink.current.cost,
        duration,
        modelSource: modelSource ?? null,
        packageEphemeral,
        extra: { error },
      });
    } else {
      // --- Success path (with or without structured output) ---

      const structuredOutput = sink.current.output;
      const hasOutput = Object.keys(structuredOutput).length > 0;
      // Validate output against schema (if any output was produced)
      if (hasOutput) {
        const outputSchema = agent.manifest.output?.schema;
        if (outputSchema) {
          const outputValidation = validateOutput(
            structuredOutput,
            asJSONSchemaObject(outputSchema),
          );
          if (!outputValidation.valid) {
            await appendRunLog(
              scope,
              runId,
              "system",
              "output_validation",
              null,
              { valid: false, errors: outputValidation.errors },
              "warn",
            );
            logger.warn("Output validation failed", {
              runId,
              errors: outputValidation.errors,
            });
          }
        }
      }

      const reportContent = sink.current.report;
      const hasReport = reportContent.length > 0;
      const result: Record<string, unknown> = {
        ...(hasOutput ? { output: structuredOutput } : {}),
        ...(hasReport ? { report: reportContent } : {}),
      };

      const memories = sink.current.memories;
      if (memories.length > 0) {
        await addPackageMemories(agent.id, orgId, applicationId, memories, runId);
      }

      const metadata = await collectAfterRunMetadata({
        orgId,
        runId,
        packageId: agent.id,
        applicationId,
        status: "success",
        cost: sink.current.cost,
        duration,
        modelSource: modelSource ?? null,
      });

      const state = sink.current.state;
      await updateRun(scope, runId, {
        status: "success",
        result,
        ...(state ? { state } : {}),
        completedAt: new Date().toISOString(),
        duration,
        notifiedAt: new Date().toISOString(),
        ...(totalTokens > 0
          ? { tokenUsage: { ...sink.current.usage } as Record<string, unknown> }
          : {}),
        cost: sink.current.cost > 0 ? sink.current.cost : null,
        ...(metadata ? { metadata } : {}),
      });

      if (hasOutput) {
        await appendRunLog(scope, runId, "result", "result", null, result, "info");
      }
      await appendRunLog(
        scope,
        runId,
        "system",
        "run_completed",
        null,
        { runId, status: "success" },
        "info",
      );
      void emitEvent("onRunStatusChange", {
        orgId,
        runId,
        packageId: agent.id,
        applicationId,
        status: "success",
        cost: sink.current.cost,
        duration,
        modelSource: modelSource ?? null,
        packageEphemeral,
        extra: { result },
      });
    }
  } catch (err) {
    // If aborted (cancelled), the cancel route already wrote DB status
    if (signal.aborted) return;

    const duration = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    const metadata = await collectAfterRunMetadata({
      orgId,
      runId,
      packageId: agent.id,
      applicationId,
      status: "failed",
      cost: sink.current.cost,
      duration,
      modelSource: modelSource ?? null,
    });
    await updateRun(scope, runId, {
      status: "failed",
      error: errorMessage,
      completedAt: new Date().toISOString(),
      duration,
      notifiedAt: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    });
    await appendRunLog(
      scope,
      runId,
      "system",
      "run_completed",
      null,
      {
        runId,
        status: "failed",
        error: errorMessage,
      },
      "error",
    );
    void emitEvent("onRunStatusChange", {
      orgId,
      runId,
      packageId: agent.id,
      applicationId,
      status: "failed",
      cost: sink.current.cost,
      duration,
      modelSource: modelSource ?? null,
      packageEphemeral,
      extra: { error: errorMessage },
    });
  } finally {
    untrackRun(runId);
  }
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
          resolveActorProfileContext(actor, packageId),
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
        modelId: modelIdOverride,
        proxyId: proxyIdOverride,
      } = inputResult;

      const runId = `exec_${crypto.randomUUID()}`;

      // Build file metadata for prompt context (no URLs — files injected directly into container)
      const fileRefs = uploadedFiles?.map((f) => ({
        fieldName: f.fieldName,
        name: f.name,
        type: f.type,
        size: f.size,
      }));

      const result = await prepareAndExecuteRun({
        runId,
        agent: effectiveAgent,
        providerProfiles,
        orgId,
        actor,
        input: parsedInput,
        files: fileRefs,
        config,
        modelId: modelIdOverride ?? preflightModelId,
        proxyId: proxyIdOverride ?? preflightProxyId,
        overrideVersionLabel,
        connectionProfileId: defaultUserProfileId ?? undefined,
        applicationId: c.get("applicationId"),
        uploadedFiles,
        apiKeyId: c.get("apiKeyId") ?? undefined,
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
    // Ownership was just verified via getRun(scope) above — we can hand
    // off to the org-scoped log reader safely.
    const logs = await listRunLogs({ runId, orgId: scope.orgId });

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

    // Update DB
    const now = new Date().toISOString();
    await updateRun(scope, runId, {
      status: "cancelled",
      error: "Cancelled by user",
      completedAt: now,
      notifiedAt: now,
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

      // ----- 1. Preflight — shape + providers + readiness (no side effects). -----
      // Running this BEFORE insertShadowPackage means invalid manifests no
      // longer leave orphan shadow rows that we'd have to clean up.
      const preflight = await runInlinePreflight({ orgId, applicationId, actor, body });
      const {
        manifest,
        prompt,
        effectiveConfig,
        effectiveInput,
        providerProfiles,
        modelIdOverride,
        proxyIdOverride,
        resolvedDeps,
      } = preflight;

      // ----- 2. Insert shadow row (now that we know the manifest is valid). -----
      const createdBy = actor?.type === "member" ? actor.id : null;
      const shadowId = await insertShadowPackage({ orgId, createdBy, manifest, prompt });
      const shadowAgent = buildShadowLoadedPackage(shadowId, manifest, prompt, resolvedDeps);

      // ----- 3. Fire the pipeline. -----
      const runId = `run_${crypto.randomUUID()}`;
      let pipelineResult;
      try {
        pipelineResult = await prepareAndExecuteRun({
          runId,
          agent: shadowAgent,
          providerProfiles,
          orgId,
          actor,
          input: effectiveInput,
          config: effectiveConfig,
          modelId: modelIdOverride,
          proxyId: proxyIdOverride,
          applicationId,
          apiKeyId: c.get("apiKeyId") ?? undefined,
        });
      } catch (err) {
        await deleteOrphanShadowPackage(shadowId);
        throw err;
      }

      if (!pipelineResult.ok) {
        await deleteOrphanShadowPackage(shadowId);
        const { error } = pipelineResult;
        if (error.code === "model_not_configured") {
          throw new ApiError({
            status: 400,
            code: "model_not_configured",
            title: "Bad Request",
            detail: error.message,
          });
        }
        if ("status" in error && typeof error.status === "number") {
          throw new ApiError({
            status: error.status,
            code: error.code,
            title: error.message,
            detail: error.message,
          });
        }
        throw new ApiError({
          status: 500,
          code: "inline_run_failed",
          title: "Inline run failed",
          detail: error.message,
        });
      }

      c.status(202);
      return c.json({ runId, packageId: shadowId });
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
