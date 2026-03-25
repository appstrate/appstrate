import { z } from "zod";
import { Hono } from "hono";
import { logger } from "../lib/logger.ts";
import type { LoadedFlow, AppEnv } from "../types/index.ts";
import {
  createExecution,
  updateExecution,
  appendExecutionLog,
  getExecution,
  getExecutionFull,
  getRunningExecutionsForPackage,
  getRunningExecutionCountForOrg,
  deletePackageExecutions,
  listPackageExecutions,
  listExecutionLogs,
  addPackageMemories,
} from "../services/state/index.ts";
import { getEffectiveProfileId } from "../services/connection-profiles.ts";
import { getAdapter, TimeoutError } from "../services/adapters/index.ts";
import type { TokenUsage } from "../services/adapters/index.ts";
import type { PromptContext, UploadedFile } from "../services/adapters/types.ts";
import {
  buildExecutionContext,
  resolvePreflightContext,
  ModelNotConfiguredError,
} from "../services/env-builder.ts";
import { getVersionDetail } from "../services/package-versions.ts";
import { validateOutput } from "../services/schema.ts";
import { parseRequestInput } from "../services/input-parser.ts";
import { trackExecution, untrackExecution, abortExecution } from "../services/execution-tracker.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { idempotency } from "../middleware/idempotency.ts";
import { ApiError, notFound, forbidden, conflict } from "../lib/errors.ts";
import { requireFlow, requireAdmin } from "../middleware/guards.ts";
import { getOrchestrator } from "../services/orchestrator/index.ts";
import { getCloudModule } from "../lib/cloud-loader.ts";
import { dispatchWebhookEvents } from "../services/webhooks.ts";
import { type Actor, getActor } from "../lib/actor.ts";

function accumulateUsage(total: TokenUsage, addition: TokenUsage): void {
  total.input_tokens += addition.input_tokens;
  total.output_tokens += addition.output_tokens;
  total.cache_creation_input_tokens =
    (total.cache_creation_input_tokens ?? 0) + (addition.cache_creation_input_tokens ?? 0);
  total.cache_read_input_tokens =
    (total.cache_read_input_tokens ?? 0) + (addition.cache_read_input_tokens ?? 0);
}

/** Fire-and-forget webhook dispatch after execution status change. */
function dispatchWebhooks(
  orgId: string,
  status: string,
  executionId: string,
  packageId: string,
  extra?: Record<string, unknown>,
  applicationId?: string | null,
): void {
  const eventType = `execution.${status}` as Parameters<typeof dispatchWebhookEvents>[1];
  dispatchWebhookEvents(
    orgId,
    eventType,
    { id: executionId, packageId, status, ...extra },
    applicationId,
  ).catch((err) => {
    logger.warn("Webhook dispatch failed", {
      executionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// --- Background execution (decoupled from client) ---

export async function executeFlowInBackground(
  executionId: string,
  _actor: Actor,
  orgId: string,
  flow: LoadedFlow,
  promptContext: PromptContext,
  flowPackage?: Buffer | null,
  inputFiles?: UploadedFile[],
  applicationId?: string | null,
) {
  const startTime = Date.now();
  const controller = trackExecution(executionId);
  const { signal } = controller;

  const cloud = getCloudModule();
  let accumulatedCost = 0;

  try {
    // Update status to running
    await updateExecution(executionId, { status: "running" });
    dispatchWebhooks(orgId, "started", executionId, flow.id, undefined, applicationId);

    // Execute via adapter
    const adapter = getAdapter();

    const timeout = (flow.manifest.timeout as number | undefined) ?? 300;
    const structuredData: Record<string, unknown> = {};
    let state: Record<string, unknown> | null = null;
    const memories: string[] = [];
    let lastAdapterError: string | null = null;
    const accumulated: TokenUsage = { input_tokens: 0, output_tokens: 0 };

    try {
      for await (const msg of adapter.execute(
        executionId,
        promptContext,
        timeout,
        flowPackage ?? undefined,
        signal,
        inputFiles,
      )) {
        if (msg.usage) accumulateUsage(accumulated, msg.usage);
        if (msg.cost != null) accumulatedCost += msg.cost;

        switch (msg.type) {
          case "progress":
            await appendExecutionLog(
              executionId,
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
            await appendExecutionLog(
              executionId,
              orgId,
              "system",
              "adapter_error",
              msg.message ?? null,
              msg.data ?? null,
              "error",
            );
            break;

          case "output":
            if (msg.data) Object.assign(structuredData, msg.data);
            await appendExecutionLog(
              executionId,
              orgId,
              "result",
              "output",
              null,
              msg.data ?? null,
              "info",
            );
            break;

          case "set_state":
            if (msg.data) state = msg.data;
            break;

          case "add_memory":
            if (msg.content) memories.push(msg.content);
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
        await updateExecution(executionId, {
          status: "timeout",
          error: `Execution timed out after ${timeout}s`,
          completedAt: new Date().toISOString(),
          duration,
          notifiedAt: new Date().toISOString(),
          ...(totalTokens > 0
            ? {
                tokensUsed: totalTokens,
                tokenUsage: { ...accumulated } as Record<string, unknown>,
              }
            : {}),
        });
        await appendExecutionLog(
          executionId,
          orgId,
          "system",
          "execution_completed",
          null,
          {
            executionId,
            status: "timeout",
          },
          "error",
        );
        dispatchWebhooks(orgId, "timeout", executionId, flow.id, { duration }, applicationId);
        return;
      }
      throw err;
    }

    const hasResult = Object.keys(structuredData).length > 0;

    if (hasResult) {
      // Validate output against schema (if defined)
      const outputSchema = flow.manifest.output?.schema;
      if (outputSchema) {
        const outputValidation = validateOutput(structuredData, outputSchema);
        if (!outputValidation.valid) {
          await appendExecutionLog(
            executionId,
            orgId,
            "system",
            "output_validation",
            null,
            { valid: false, errors: outputValidation.errors },
            "warn",
          );
          logger.warn("Output validation failed", { executionId, errors: outputValidation.errors });
        }
      }

      // Guard: don't overwrite "cancelled" status
      if (signal.aborted) return;

      const duration = Date.now() - startTime;
      const totalTokens = accumulated.input_tokens + accumulated.output_tokens;

      // Build result object
      const result: Record<string, unknown> = { data: structuredData };

      // Persist memories
      if (memories.length > 0) {
        await addPackageMemories(flow.id, orgId, memories, executionId);
      }

      // Record billing (keep existing cloud billing logic exactly as-is)
      if (cloud && accumulatedCost > 0) {
        try {
          await cloud.cloudHooks.recordUsage(orgId, executionId, accumulatedCost);
        } catch (err) {
          logger.error("Failed to record usage — manual reconciliation needed", {
            err: err instanceof Error ? err.message : String(err),
            orgId,
            executionId,
            accumulatedCost,
          });
        }
      }

      await updateExecution(executionId, {
        status: "success",
        result,
        ...(state ? { state } : {}),
        completedAt: new Date().toISOString(),
        duration,
        notifiedAt: new Date().toISOString(),
        tokensUsed: totalTokens > 0 ? totalTokens : undefined,
        ...(totalTokens > 0 ? { tokenUsage: { ...accumulated } as Record<string, unknown> } : {}),
        cost: accumulatedCost > 0 ? accumulatedCost : null,
      });

      await appendExecutionLog(executionId, orgId, "result", "result", null, result, "info");
      await appendExecutionLog(
        executionId,
        orgId,
        "system",
        "execution_completed",
        null,
        { executionId, status: "success" },
        "info",
      );
      dispatchWebhooks(
        orgId,
        "completed",
        executionId,
        flow.id,
        { result, duration },
        applicationId,
      );
    } else {
      // Keep the existing no-result/failed path but update variable references
      if (signal.aborted) return;

      const duration = Date.now() - startTime;
      const totalTokens = accumulated.input_tokens + accumulated.output_tokens;

      const error =
        lastAdapterError ??
        (totalTokens === 0
          ? promptContext.proxyUrl
            ? "The AI agent could not reach the LLM API — the configured proxy may be unreachable or rejecting connections"
            : "The AI agent could not reach the LLM API — check that the API key is valid and the provider is accessible"
          : "No result returned from adapter");

      await updateExecution(executionId, {
        status: "failed",
        error,
        completedAt: new Date().toISOString(),
        duration,
        notifiedAt: new Date().toISOString(),
      });
      await appendExecutionLog(
        executionId,
        orgId,
        "system",
        "execution_completed",
        null,
        {
          executionId,
          status: "failed",
          error,
        },
        "error",
      );
      dispatchWebhooks(orgId, "failed", executionId, flow.id, { error, duration }, applicationId);
    }
  } catch (err) {
    // If aborted (cancelled), the cancel route already wrote DB status
    if (signal.aborted) return;

    const duration = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    await updateExecution(executionId, {
      status: "failed",
      error: errorMessage,
      completedAt: new Date().toISOString(),
      duration,
      notifiedAt: new Date().toISOString(),
    });
    await appendExecutionLog(
      executionId,
      orgId,
      "system",
      "execution_completed",
      null,
      {
        executionId,
        status: "failed",
        error: errorMessage,
      },
      "error",
    );
    dispatchWebhooks(
      orgId,
      "failed",
      executionId,
      flow.id,
      { error: errorMessage, duration },
      applicationId,
    );
  } finally {
    untrackExecution(executionId);
  }
}

// --- Router ---

export function createExecutionsRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/flows/:scope/:name/run — execute a flow (fire-and-forget, returns JSON)
  router.post(
    "/flows/:scope{@[^/]+}/:name/run",
    rateLimit(20),
    idempotency(),
    requireFlow(),
    async (c) => {
      const flow = c.get("flow");
      const orgId = c.get("orgId");
      const actor = getActor(c);
      const packageId = flow.id;
      const profileIdOverride = c.req.query("profileId");

      // Version override from query param (e.g. ?version=1.2.0 or ?version=latest)
      const versionOverride = c.req.query("version");

      // If a specific version is requested, resolve and override flow data
      let effectiveFlow = flow;
      let overrideVersionId: number | undefined;
      if (versionOverride && flow.source !== "system") {
        const versionDetail = await getVersionDetail(flow.id, versionOverride);
        if (!versionDetail) {
          throw notFound(`Version '${versionOverride}' not found`);
        }
        overrideVersionId = versionDetail.id;
        // Override manifest and content — version manifest replaces draft entirely
        // (shallow merge would keep draft keys like config.schema when the version lacks them)
        effectiveFlow = {
          ...flow,
          manifest: versionDetail.manifest as typeof flow.manifest,
          prompt: versionDetail.textContent ?? flow.prompt,
        };
      }

      // Run independent pre-flight operations in parallel (using effectiveFlow for version-aware validation)
      const [preflightResult, userProfileId, inputResult] = await Promise.all([
        resolvePreflightContext({
          flow: effectiveFlow,
          actor,
          packageId,
          orgId,
          profileIdOverride,
        }),
        profileIdOverride
          ? Promise.resolve(profileIdOverride)
          : getEffectiveProfileId(actor, packageId),
        parseRequestInput(c, effectiveFlow.manifest.input?.schema),
      ]);
      const { providerProfiles, config } = preflightResult;

      const {
        input: parsedInput,
        uploadedFiles,
        modelId: modelIdOverride,
        proxyId: proxyIdOverride,
      } = inputResult;

      const executionId = `exec_${crypto.randomUUID()}`;

      // Build file metadata for prompt context (no URLs — files injected directly into container)
      const fileRefs = uploadedFiles?.map((f) => ({
        fieldName: f.fieldName,
        name: f.name,
        type: f.type,
        size: f.size,
      }));

      // Build execution context (tokens, config, state, providers, package, version)
      let promptContext: PromptContext;
      let flowPackage: Buffer | null;
      let packageVersionId: number | null;
      let proxyLabel: string | null;
      let modelLabel: string | null;
      try {
        ({ promptContext, flowPackage, packageVersionId, proxyLabel, modelLabel } =
          await buildExecutionContext({
            executionId,
            flow: effectiveFlow,
            providerProfiles,
            orgId,
            actor,
            input: parsedInput,
            files: fileRefs,
            config,
            modelId: modelIdOverride,
            proxyId: proxyIdOverride,
            overrideVersionId,
          }));
      } catch (err) {
        if (err instanceof ModelNotConfiguredError) {
          throw new ApiError({
            status: 400,
            code: "model_not_configured",
            title: "Bad Request",
            detail: err.message,
          });
        }
        throw err;
      }

      // Pre-execution quota check (Cloud only — reject before creating the execution record)
      const cloud = getCloudModule();
      if (cloud) {
        try {
          const runningCount = await getRunningExecutionCountForOrg(orgId);
          await cloud.cloudHooks.checkQuota(orgId, runningCount);
        } catch (err) {
          if (err instanceof cloud.QuotaExceededError) {
            throw new ApiError({
              status: 402,
              code: "quota_exceeded",
              title: "Payment Required",
              detail: err.message,
            });
          }
          throw err;
        }
      }

      // Create execution record
      await createExecution(
        executionId,
        packageId,
        actor,
        orgId,
        parsedInput ?? null,
        undefined,
        packageVersionId ?? undefined,
        userProfileId,
        proxyLabel ?? undefined,
        modelLabel ?? undefined,
        c.get("applicationId") ?? null,
      );

      // Fire-and-forget background execution
      executeFlowInBackground(
        executionId,
        actor,
        orgId,
        effectiveFlow,
        promptContext,
        flowPackage,
        uploadedFiles,
        c.get("applicationId") ?? null,
      ).catch((err) => {
        logger.error("Unhandled error in background execution", {
          executionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      return c.json({ executionId });
    },
  );

  // GET /api/flows/:scope/:name/executions — list executions for a flow
  router.get("/flows/:scope{@[^/]+}/:name/executions", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const orgId = c.get("orgId");
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .catch(50)
      .parse(c.req.query("limit") ?? 50);
    const endUser = c.get("endUser");
    const rows = await listPackageExecutions(flow.id, orgId, limit);
    // End-user scoping: end-users can only see their own executions
    const filtered = endUser
      ? rows.filter((r: Record<string, unknown>) => r.endUserId === endUser.id)
      : rows;
    return c.json(filtered);
  });

  // GET /api/executions/:id — get a single execution
  router.get("/executions/:id", async (c) => {
    const execId = c.req.param("id");
    const orgId = c.get("orgId");
    const row = await getExecutionFull(execId);
    if (!row || row.orgId !== orgId) {
      throw notFound("Execution not found");
    }
    // End-user scoping: end-users can only see their own executions
    const endUser = c.get("endUser");
    if (endUser && row.endUserId !== endUser.id) {
      throw notFound("Execution not found");
    }
    return c.json(row);
  });

  // GET /api/executions/:id/logs — get execution logs
  router.get("/executions/:id/logs", async (c) => {
    const execId = c.req.param("id");
    const orgId = c.get("orgId");
    const exec = await getExecution(execId);
    if (!exec || exec.orgId !== orgId) {
      throw notFound("Execution not found");
    }
    // End-user scoping: end-users can only see their own execution logs
    const endUser = c.get("endUser");
    if (endUser && exec.endUserId !== endUser.id) {
      throw notFound("Execution not found");
    }
    const logs = await listExecutionLogs(execId, orgId);

    // Filter by role: non-admins don't see debug logs
    const role = c.get("orgRole");
    const isAdmin = role === "admin" || role === "owner";
    const filtered = isAdmin ? logs : logs.filter((l) => l.level !== "debug");

    return c.json(filtered);
  });

  // POST /api/executions/:id/cancel — cancel a running/pending execution
  router.post("/executions/:id/cancel", async (c) => {
    const execId = c.req.param("id");
    const orgId = c.get("orgId");

    const execution = await getExecution(execId);
    if (!execution) {
      throw notFound("Execution not found");
    }

    // Verify ownership (same org)
    if (execution.orgId !== orgId) {
      throw forbidden("Not authorized");
    }

    // Verify cancellable
    if (execution.status !== "pending" && execution.status !== "running") {
      throw conflict("not_cancellable", "This execution cannot be cancelled");
    }

    // Update DB
    const now = new Date().toISOString();
    await updateExecution(execId, {
      status: "cancelled",
      error: "Cancelled by user",
      completedAt: now,
      notifiedAt: now,
    });

    // Log the cancellation
    await appendExecutionLog(
      execId,
      orgId,
      "system",
      "execution_completed",
      null,
      {
        executionId: execId,
        status: "cancelled",
      },
      "info",
    );

    // Abort in-flight fetch calls immediately, then stop the container as backup
    abortExecution(execId);
    getOrchestrator()
      .stopByExecutionId(execId)
      .catch(() => {});

    dispatchWebhooks(
      orgId,
      "cancelled",
      execId,
      execution.packageId,
      undefined,
      c.get("applicationId") ?? null,
    );

    return c.json({ ok: true });
  });

  // DELETE /api/flows/:scope/:name/executions — delete all executions for a flow (admin only)
  router.delete(
    "/flows/:scope{@[^/]+}/:name/executions",
    requireFlow(),
    requireAdmin(),
    async (c) => {
      const flow = c.get("flow");
      const orgId = c.get("orgId");

      const running = await getRunningExecutionsForPackage(flow.id);
      if (running > 0) {
        throw conflict("execution_in_progress", `${running} execution(s) still running`);
      }

      const deleted = await deletePackageExecutions(flow.id, orgId);
      return c.json({ deleted });
    },
  );

  return router;
}
