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
  listScheduleRuns,
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
import { getCloudModule } from "../lib/cloud-loader.ts";
import { dispatchRunWebhook } from "../services/webhooks.ts";
import { prepareAndExecuteRun, resolveRunPreflight } from "../services/run-pipeline.ts";
import { getActor } from "../lib/actor.ts";
function accumulateUsage(total: TokenUsage, addition: TokenUsage): void {
  total.input_tokens += addition.input_tokens;
  total.output_tokens += addition.output_tokens;
  total.cache_creation_input_tokens =
    (total.cache_creation_input_tokens ?? 0) + (addition.cache_creation_input_tokens ?? 0);
  total.cache_read_input_tokens =
    (total.cache_read_input_tokens ?? 0) + (addition.cache_read_input_tokens ?? 0);
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

  const cloud = getCloudModule();
  let accumulatedCost = 0;

  try {
    // Update status to running
    await updateRun(runId, orgId, applicationId, { status: "running" });
    dispatchRunWebhook(orgId, applicationId, "started", runId, agent.id);

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
        await updateRun(runId, orgId, applicationId, {
          status: "timeout",
          error: `Run timed out after ${timeout}s`,
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
        dispatchRunWebhook(orgId, applicationId, "timeout", runId, agent.id, { duration });
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
      await updateRun(runId, orgId, applicationId, {
        status: "failed",
        error,
        completedAt: new Date().toISOString(),
        duration,
        notifiedAt: new Date().toISOString(),
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
      dispatchRunWebhook(orgId, applicationId, "failed", runId, agent.id, { error, duration });
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

      let metadata: Record<string, unknown> | undefined;
      if (cloud && accumulatedCost > 0) {
        try {
          metadata = await cloud.cloudHooks.recordUsage(orgId, runId, accumulatedCost, {
            modelSource: modelSource ?? "system",
          });
        } catch (err) {
          logger.error("Failed to record usage — manual reconciliation needed", {
            err: err instanceof Error ? err.message : String(err),
            orgId,
            runId,
            accumulatedCost,
          });
        }
      }

      await updateRun(runId, orgId, applicationId, {
        status: "success",
        result,
        ...(state ? { state } : {}),
        completedAt: new Date().toISOString(),
        duration,
        notifiedAt: new Date().toISOString(),
        tokensUsed: totalTokens > 0 ? totalTokens : undefined,
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
      dispatchRunWebhook(orgId, applicationId, "completed", runId, agent.id, { result, duration });
    }
  } catch (err) {
    // If aborted (cancelled), the cancel route already wrote DB status
    if (signal.aborted) return;

    const duration = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    await updateRun(runId, orgId, applicationId, {
      status: "failed",
      error: errorMessage,
      completedAt: new Date().toISOString(),
      duration,
      notifiedAt: new Date().toISOString(),
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
    dispatchRunWebhook(orgId, applicationId, "failed", runId, agent.id, {
      error: errorMessage,
      duration,
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
      let overrideVersionId: number | undefined;
      if (versionOverride && agent.source !== "system") {
        const versionDetail = await getVersionDetail(agent.id, versionOverride);
        if (!versionDetail) {
          throw notFound(`Version '${versionOverride}' not found`);
        }
        overrideVersionId = versionDetail.id;
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
            effectiveAgent.manifest.input?.fileConstraints,
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
        overrideVersionId,
        connectionProfileId: defaultUserProfileId ?? undefined,
        applicationId: c.get("applicationId"),
        uploadedFiles,
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
        if (error.code === "quota_exceeded") {
          throw new ApiError({
            status: 402,
            code: "quota_exceeded",
            title: "Payment Required",
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

  // GET /api/schedules/:id/runs — list runs for a schedule
  router.get("/schedules/:id/runs", async (c) => {
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
    const result = await listScheduleRuns(scheduleId, orgId, {
      limit,
      offset,
      applicationId: c.get("applicationId"),
    });
    return c.json(result);
  });

  // GET /api/runs/:id — get a single run
  router.get("/runs/:id", async (c) => {
    const runId = c.req.param("id");
    const orgId = c.get("orgId");
    const row = await getRunFull(runId, orgId, c.get("applicationId"));
    if (!row) {
      throw notFound("Run not found");
    }
    // End-user scoping: end-users can only see their own runs
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
    // End-user scoping: end-users can only see their own run logs
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

    dispatchRunWebhook(orgId, c.get("applicationId"), "cancelled", runId, run.packageId);

    return c.json({ ok: true });
  });

  // DELETE /api/agents/:scope/:name/runs — delete all runs for an agent
  router.delete(
    "/agents/:scope{@[^/]+}/:name/runs",
    requireAgent(),
    requirePermission("runs", "delete"),
    async (c) => {
      const agent = c.get("agent");
      const orgId = c.get("orgId");

      const appId = c.get("applicationId");
      const running = await getRunningRunsForPackage(agent.id, orgId, appId);
      if (running > 0) {
        throw conflict("run_in_progress", `${running} run(s) still running`);
      }

      const deleted = await deletePackageRuns(agent.id, orgId, appId);
      return c.json({ deleted });
    },
  );

  return router;
}
