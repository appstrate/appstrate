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
import type { TokenUsage } from "../services/adapters/index.ts";
import type { PromptContext, UploadedFile } from "../services/adapters/types.ts";
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
import { getInlineRunLimits } from "../services/run-limits.ts";
import {
  insertShadowPackage,
  buildShadowLoadedPackage,
  deleteOrphanShadowPackage,
  isInlineShadowPackageId,
} from "../services/inline-run.ts";
import { runInlinePreflight, type InlineRunBody } from "../services/inline-run-preflight.ts";
function accumulateUsage(total: TokenUsage, addition: TokenUsage): void {
  total.input_tokens += addition.input_tokens;
  total.output_tokens += addition.output_tokens;
  total.cache_creation_input_tokens =
    (total.cache_creation_input_tokens ?? 0) + (addition.cache_creation_input_tokens ?? 0);
  total.cache_read_input_tokens =
    (total.cache_read_input_tokens ?? 0) + (addition.cache_read_input_tokens ?? 0);
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
  promptContext: PromptContext,
  applicationId: string,
  agentPackage?: Buffer | null,
  inputFiles?: UploadedFile[],
  modelSource?: string | null,
) {
  const startTime = Date.now();
  const controller = trackRun(runId);
  const { signal } = controller;
  // Derived once — cheap string test used to decorate every lifecycle event.
  const packageEphemeral = isInlineShadowPackageId(agent.id);

  let accumulatedCost = 0;

  try {
    // Update status to running
    await updateRun(runId, orgId, applicationId, { status: "running" });
    void emitEvent("onRunStatusChange", {
      orgId,
      runId,
      packageId: agent.id,
      applicationId,
      status: "started",
      packageEphemeral,
    });

    // Execute via adapter
    const adapter = new PiAdapter();

    const timeout = (agent.manifest.timeout as number | undefined) ?? 300;
    const structuredOutput: Record<string, unknown> = {};
    let state: Record<string, unknown> | null = null;
    const memories: string[] = [];
    let reportContent = "";
    let lastAdapterError: string | null = null;
    const accumulated: TokenUsage = { input_tokens: 0, output_tokens: 0 };

    try {
      for await (const msg of adapter.execute(
        runId,
        promptContext,
        timeout,
        agentPackage ?? undefined,
        signal,
        inputFiles,
      )) {
        if (msg.usage) accumulateUsage(accumulated, msg.usage);
        if (msg.cost != null) accumulatedCost += msg.cost;

        switch (msg.type) {
          case "progress":
            await appendRunLog(
              runId,
              orgId,
              "progress",
              "progress",
              msg.message ?? null,
              msg.data ?? null,
              msg.level ?? "debug",
            );
            break;

          case "error":
            lastAdapterError = msg.message ?? null;
            await appendRunLog(
              runId,
              orgId,
              "system",
              "adapter_error",
              msg.message ?? null,
              msg.data ?? null,
              "error",
            );
            break;

          case "output":
            if (msg.data) Object.assign(structuredOutput, msg.data);
            await appendRunLog(runId, orgId, "result", "output", null, msg.data ?? null, "info");
            break;

          case "set_state":
            if (msg.data) state = msg.data;
            break;

          case "add_memory":
            if (msg.content) memories.push(msg.content);
            break;

          case "report":
            if (msg.content) {
              reportContent += (reportContent ? "\n\n" : "") + msg.content;
            }
            await appendRunLog(
              runId,
              orgId,
              "result",
              "report",
              null,
              { content: msg.content } as Record<string, unknown>,
              "info",
            );
            break;
        }
      }
    } catch (err) {
      if (signal.aborted) {
        // Cancelled by user — cancel route already wrote DB status
        return;
      }
      if (err instanceof TimeoutError) {
        const duration = Date.now() - startTime;
        const totalTokens = accumulated.input_tokens + accumulated.output_tokens;
        const metadata = await collectAfterRunMetadata({
          orgId,
          runId,
          packageId: agent.id,
          applicationId,
          status: "timeout",
          cost: accumulatedCost,
          duration,
          modelSource: modelSource ?? null,
        });
        await updateRun(runId, orgId, applicationId, {
          status: "timeout",
          error: `Run timed out after ${timeout}s`,
          completedAt: new Date().toISOString(),
          duration,
          notifiedAt: new Date().toISOString(),
          ...(totalTokens > 0
            ? {
                tokenUsage: { ...accumulated } as Record<string, unknown>,
              }
            : {}),
          ...(metadata ? { metadata } : {}),
        });
        await appendRunLog(
          runId,
          orgId,
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
          cost: accumulatedCost,
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
    const totalTokens = accumulated.input_tokens + accumulated.output_tokens;
    const error =
      lastAdapterError ??
      (totalTokens === 0
        ? promptContext.proxyUrl
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
        cost: accumulatedCost,
        duration,
        modelSource: modelSource ?? null,
      });
      await updateRun(runId, orgId, applicationId, {
        status: "failed",
        error,
        completedAt: new Date().toISOString(),
        duration,
        notifiedAt: new Date().toISOString(),
        ...(metadata ? { metadata } : {}),
      });
      await appendRunLog(
        runId,
        orgId,
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
        cost: accumulatedCost,
        duration,
        modelSource: modelSource ?? null,
        packageEphemeral,
        extra: { error },
      });
    } else {
      // --- Success path (with or without structured output) ---

      // Validate output against schema (if any output was produced)
      const hasOutput = Object.keys(structuredOutput).length > 0;
      if (hasOutput) {
        const outputSchema = agent.manifest.output?.schema;
        if (outputSchema) {
          const outputValidation = validateOutput(
            structuredOutput,
            asJSONSchemaObject(outputSchema),
          );
          if (!outputValidation.valid) {
            await appendRunLog(
              runId,
              orgId,
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

      const hasReport = reportContent.length > 0;
      const result: Record<string, unknown> = {
        ...(hasOutput ? { output: structuredOutput } : {}),
        ...(hasReport ? { report: reportContent } : {}),
      };

      if (memories.length > 0) {
        await addPackageMemories(agent.id, orgId, applicationId, memories, runId);
      }

      const metadata = await collectAfterRunMetadata({
        orgId,
        runId,
        packageId: agent.id,
        applicationId,
        status: "success",
        cost: accumulatedCost,
        duration,
        modelSource: modelSource ?? null,
      });

      await updateRun(runId, orgId, applicationId, {
        status: "success",
        result,
        ...(state ? { state } : {}),
        completedAt: new Date().toISOString(),
        duration,
        notifiedAt: new Date().toISOString(),
        ...(totalTokens > 0 ? { tokenUsage: { ...accumulated } as Record<string, unknown> } : {}),
        cost: accumulatedCost > 0 ? accumulatedCost : null,
        ...(metadata ? { metadata } : {}),
      });

      if (hasOutput) {
        await appendRunLog(runId, orgId, "result", "result", null, result, "info");
      }
      await appendRunLog(
        runId,
        orgId,
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
        cost: accumulatedCost,
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
      cost: accumulatedCost,
      duration,
      modelSource: modelSource ?? null,
    });
    await updateRun(runId, orgId, applicationId, {
      status: "failed",
      error: errorMessage,
      completedAt: new Date().toISOString(),
      duration,
      notifiedAt: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    });
    await appendRunLog(
      runId,
      orgId,
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
      cost: accumulatedCost,
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
          getAgentAppProfile(c.get("applicationId"), packageId),
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
    const orgId = c.get("orgId");
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
    const result = await listPackageRuns(agent.id, orgId, {
      limit,
      offset,
      applicationId: c.get("applicationId"),
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
    const orgId = c.get("orgId");
    const row = await getRunFull(runId, orgId, c.get("applicationId"));
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
    const orgId = c.get("orgId");
    const exec = await getRun(runId, orgId, c.get("applicationId"));
    if (!exec) {
      throw notFound("Run not found");
    }
    const endUser = c.get("endUser");
    if (endUser && exec.endUserId !== endUser.id) {
      throw notFound("Run not found");
    }
    const logs = await listRunLogs(runId, orgId);

    return c.json(logs);
  });

  // POST /api/runs/:id/cancel — cancel a running/pending run
  router.post("/runs/:id/cancel", requirePermission("runs", "cancel"), async (c) => {
    const runId = c.req.param("id")!;
    const orgId = c.get("orgId");

    const run = await getRun(runId, orgId, c.get("applicationId"));
    if (!run) {
      throw notFound("Run not found");
    }

    // Verify cancellable
    if (run.status !== "pending" && run.status !== "running") {
      throw conflict("not_cancellable", "This run cannot be cancelled");
    }

    // Update DB
    const now = new Date().toISOString();
    await updateRun(runId, orgId, c.get("applicationId"), {
      status: "cancelled",
      error: "Cancelled by user",
      completedAt: now,
      notifiedAt: now,
    });

    // Log the cancellation
    await appendRunLog(
      runId,
      orgId,
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
      orgId,
      runId,
      packageId: run.packageId,
      applicationId: c.get("applicationId"),
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

      await runInlinePreflight({ orgId, applicationId, actor, body });

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
      const orgId = c.get("orgId");

      const applicationId = c.get("applicationId");
      const running = await getRunningRunsForPackage(agent.id, orgId, applicationId);
      if (running > 0) {
        throw conflict("run_in_progress", `${running} run(s) still running`);
      }

      const deleted = await deletePackageRuns(agent.id, orgId, applicationId);
      return c.json({ deleted });
    },
  );

  return router;
}
