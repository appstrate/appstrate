// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { Hono } from "hono";
import { logger } from "../lib/logger.ts";
import type { LoadedPackage, AppEnv } from "../types/index.ts";
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
  listScheduleExecutions,
  listExecutionLogs,
  addPackageMemories,
  getPackageConfig,
} from "../services/state/index.ts";
import {
  resolveActorProfileContext,
  getFlowOrgProfile,
  resolveProviderProfiles,
} from "../services/connection-profiles.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { validateFlowReadiness } from "../services/flow-readiness.ts";
import { PiAdapter, TimeoutError } from "../services/adapters/index.ts";
import type { TokenUsage } from "../services/adapters/index.ts";
import type { PromptContext, UploadedFile } from "../services/adapters/types.ts";
import { buildExecutionContext, ModelNotConfiguredError } from "../services/env-builder.ts";
import { getVersionDetail } from "../services/package-versions.ts";
import { validateOutput } from "../services/schema.ts";
import { parseRequestInput } from "../services/input-parser.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { trackExecution, untrackExecution, abortExecution } from "../services/execution-tracker.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { idempotency } from "../middleware/idempotency.ts";
import { ApiError, notFound, forbidden, conflict } from "../lib/errors.ts";
import { requireFlow } from "../middleware/guards.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getOrchestrator } from "../services/orchestrator/index.ts";
import { getCloudModule } from "../lib/cloud-loader.ts";
import { dispatchWebhookEvents } from "../services/webhooks.ts";
import { getActor } from "../lib/actor.ts";

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
  orgId: string,
  flow: LoadedPackage,
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
    const adapter = new PiAdapter();

    const timeout = (flow.manifest.timeout as number | undefined) ?? 300;
    const structuredOutput: Record<string, unknown> = {};
    let state: Record<string, unknown> | null = null;
    const memories: string[] = [];
    let reportContent = "";
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
            if (msg.data) Object.assign(structuredOutput, msg.data);
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

          case "report":
            if (msg.content) {
              reportContent += (reportContent ? "\n\n" : "") + msg.content;
            }
            await appendExecutionLog(
              executionId,
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

    // Determine outcome: fail only on adapter error or zero tokens (LLM unreachable).
    // A flow without the output tool succeeds even without structured output.
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
        { executionId, status: "failed", error },
        "error",
      );
      dispatchWebhooks(orgId, "failed", executionId, flow.id, { error, duration }, applicationId);
    } else {
      // --- Success path (with or without structured output) ---

      // Validate output against schema (if any output was produced)
      const hasOutput = Object.keys(structuredOutput).length > 0;
      if (hasOutput) {
        const outputSchema = flow.manifest.output?.schema;
        if (outputSchema) {
          const outputValidation = validateOutput(
            structuredOutput,
            asJSONSchemaObject(outputSchema),
          );
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
            logger.warn("Output validation failed", {
              executionId,
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
        await addPackageMemories(flow.id, orgId, memories, executionId);
      }

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

      if (hasOutput) {
        await appendExecutionLog(executionId, orgId, "result", "result", null, result, "info");
      }
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
    requirePermission("flows", "run"),
    async (c) => {
      const flow = c.get("flow");
      const orgId = c.get("orgId");
      const actor = getActor(c);
      const packageId = flow.id;
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

      // Resolve org profile and actor profile context in parallel
      const [flowOrgProfile, { defaultUserProfileId, userProviderOverrides }] = await Promise.all([
        getFlowOrgProfile(orgId, packageId),
        resolveActorProfileContext(actor, packageId),
      ]);
      const flowOrgProfileId = flowOrgProfile?.id ?? null;

      // Resolve provider profiles, config, and validate flow readiness (inlined preflight)
      const manifestProviders = resolveManifestProviders(effectiveFlow.manifest);

      const [providerProfiles, packageConfig, inputResult] = await Promise.all([
        resolveProviderProfiles(
          manifestProviders,
          defaultUserProfileId,
          userProviderOverrides,
          flowOrgProfileId,
          orgId,
        ),
        getPackageConfig(orgId, packageId),
        parseRequestInput(
          c,
          effectiveFlow.manifest.input?.schema
            ? asJSONSchemaObject(effectiveFlow.manifest.input.schema)
            : undefined,
          effectiveFlow.manifest.input?.fileConstraints,
        ),
      ]);

      await validateFlowReadiness({
        flow: effectiveFlow,
        providerProfiles,
        orgId,
        config: packageConfig.config,
      });

      const config = packageConfig.config;
      const preflightModelId = packageConfig.modelId;
      const preflightProxyId = packageConfig.proxyId;

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
            modelId: modelIdOverride ?? preflightModelId,
            proxyId: proxyIdOverride ?? preflightProxyId,
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

      // Extract just the profileId map (strip source field)
      const profileIdMap = Object.fromEntries(
        Object.entries(providerProfiles).map(([k, v]) => [k, v.profileId]),
      );

      // Create execution record
      await createExecution(
        executionId,
        packageId,
        actor,
        orgId,
        parsedInput ?? null,
        undefined,
        packageVersionId ?? undefined,
        defaultUserProfileId ?? undefined,
        proxyLabel ?? undefined,
        modelLabel ?? undefined,
        c.get("applicationId") ?? null,
        profileIdMap,
      );

      // Fire-and-forget background execution
      executeFlowInBackground(
        executionId,
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
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .catch(0)
      .parse(c.req.query("offset") ?? 0);
    const endUser = c.get("endUser");
    const result = await listPackageExecutions(flow.id, orgId, {
      limit,
      offset,
      endUserId: endUser?.id,
    });
    return c.json(result);
  });

  // GET /api/schedules/:id/executions — list executions for a schedule
  router.get("/schedules/:id/executions", async (c) => {
    const scheduleId = c.req.param("id");
    const orgId = c.get("orgId");
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .catch(20)
      .parse(c.req.query("limit") ?? 20);
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .catch(0)
      .parse(c.req.query("offset") ?? 0);
    const result = await listScheduleExecutions(scheduleId, orgId, { limit, offset });
    return c.json(result);
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

    return c.json(logs);
  });

  // POST /api/executions/:id/cancel — cancel a running/pending execution
  router.post("/executions/:id/cancel", requirePermission("executions", "cancel"), async (c) => {
    const execId = c.req.param("id")!;
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

  // DELETE /api/flows/:scope/:name/executions — delete all executions for a flow
  router.delete(
    "/flows/:scope{@[^/]+}/:name/executions",
    requireFlow(),
    requirePermission("executions", "delete"),
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
