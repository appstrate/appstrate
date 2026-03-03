import { Hono } from "hono";
import { logger } from "../lib/logger.ts";
import type { LoadedFlow, AppEnv } from "../types/index.ts";
import {
  getPackageConfig,
  createExecution,
  updateExecution,
  appendExecutionLog,
  getExecution,
  getExecutionFull,
  getRunningExecutionsForPackage,
  deletePackageExecutions,
  listPackageExecutions,
  listExecutionLogs,
  addPackageMemories,
} from "../services/state.ts";
import { validateFlowDependencies } from "../services/dependency-validation.ts";
import { resolveServiceProfiles, getEffectiveProfileId } from "../services/connection-profiles.ts";
import { getAdapter, TimeoutError, buildRetryPrompt } from "../services/adapters/index.ts";
import type { TokenUsage } from "../services/adapters/index.ts";
import type { PromptContext, UploadedFile } from "../services/adapters/types.ts";
import { buildExecutionContext } from "../services/env-builder.ts";
import { getVersionDetail } from "../services/package-versions.ts";
import { validateConfig, validateOutput } from "../services/schema.ts";
import { parseRequestInput } from "../services/input-parser.ts";
import { trackExecution, untrackExecution, abortExecution } from "../services/execution-tracker.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requireFlow, requireAdmin } from "../middleware/guards.ts";
import { stopContainer } from "../services/docker.ts";

const MIN_RETRY_TIME_MS = 5_000;

function accumulateUsage(total: TokenUsage, addition: TokenUsage): void {
  total.input_tokens += addition.input_tokens;
  total.output_tokens += addition.output_tokens;
  total.cache_creation_input_tokens =
    (total.cache_creation_input_tokens ?? 0) + (addition.cache_creation_input_tokens ?? 0);
  total.cache_read_input_tokens =
    (total.cache_read_input_tokens ?? 0) + (addition.cache_read_input_tokens ?? 0);
}

// --- Background execution (decoupled from client) ---

export async function executeFlowInBackground(
  executionId: string,
  userId: string,
  orgId: string,
  flow: LoadedFlow,
  promptContext: PromptContext,
  flowPackage?: Buffer | null,
  inputFiles?: UploadedFile[],
) {
  const startTime = Date.now();
  const controller = trackExecution(executionId);
  const { signal } = controller;

  try {
    // Update status to running
    await updateExecution(executionId, { status: "running" });

    // Execute via adapter
    const adapter = getAdapter();

    const timeout = flow.manifest.execution?.timeout ?? 300;
    let result: Record<string, unknown> | null = null;
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
        if (msg.type === "progress") {
          await appendExecutionLog(
            executionId,
            userId,
            orgId,
            "progress",
            "progress",
            msg.message ?? null,
            msg.data ?? null,
          );
        } else if (msg.type === "result" && msg.data) {
          result = msg.data;
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
        await appendExecutionLog(executionId, userId, orgId, "error", "execution_completed", null, {
          executionId,
          status: "timeout",
        });
        return;
      }
      throw err;
    }

    if (result) {
      // Validate against output schema and retry if invalid
      const outputSchema = flow.manifest.output?.schema;
      if (outputSchema) {
        const maxRetries = flow.manifest.execution?.outputRetries ?? 2;
        const timeoutMs = timeout * 1000;
        let retriesLeft = maxRetries;
        let outputValidation = validateOutput(result, outputSchema);

        while (!outputValidation.valid && retriesLeft > 0) {
          const remaining = timeoutMs - (Date.now() - startTime);
          if (remaining < MIN_RETRY_TIME_MS) break;

          // Brief pause before retrying to avoid hammering on identical invalid results
          await new Promise((r) => setTimeout(r, 1_000));

          const attempt = maxRetries - retriesLeft + 1;
          await appendExecutionLog(
            executionId,
            userId,
            orgId,
            "system",
            "output_validation_retry",
            null,
            {
              attempt,
              maxRetries,
              errors: outputValidation.errors,
            },
          );

          const retryPrompt = buildRetryPrompt(result, outputValidation.errors, outputSchema);
          const retryCtx: PromptContext = {
            rawPrompt: retryPrompt,
            tokens: promptContext.tokens,
            config: {},
            previousState: null,
            input: {},
            schemas: { output: outputSchema },
            services: [],
            llmModel: promptContext.llmModel,
          };

          try {
            for await (const msg of adapter.execute(
              executionId,
              retryCtx,
              Math.min(60, Math.floor(remaining / 1000)),
            )) {
              if (msg.usage) accumulateUsage(accumulated, msg.usage);
              if (msg.type === "progress") {
                await appendExecutionLog(
                  executionId,
                  userId,
                  orgId,
                  "progress",
                  "progress",
                  msg.message ?? null,
                  msg.data ?? null,
                );
              } else if (msg.type === "result" && msg.data) {
                result = msg.data;
              }
            }
          } catch (err) {
            if (err instanceof TimeoutError) break;
            throw err;
          }

          retriesLeft--;
          outputValidation = validateOutput(result, outputSchema);
        }

        if (!outputValidation.valid) {
          await appendExecutionLog(
            executionId,
            userId,
            orgId,
            "system",
            "output_validation",
            null,
            {
              valid: false,
              errors: outputValidation.errors,
            },
          );
          logger.warn("Output validation failed", {
            executionId,
            errors: outputValidation.errors,
          });
        }
      }

      // Guard: don't overwrite "cancelled" status written by the cancel route
      if (signal.aborted) return;

      const duration = Date.now() - startTime;
      const totalTokens = accumulated.input_tokens + accumulated.output_tokens;
      const resultState =
        result.state && typeof result.state === "object"
          ? (result.state as Record<string, unknown>)
          : undefined;

      // Extract and persist memories
      const resultMemories = Array.isArray(result.memories)
        ? result.memories.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
        : undefined;
      if (resultMemories && resultMemories.length > 0) {
        await addPackageMemories(flow.id, orgId, resultMemories, executionId);
      }

      await updateExecution(executionId, {
        status: "success",
        result,
        ...(resultState ? { state: resultState } : {}),
        completedAt: new Date().toISOString(),
        duration,
        notifiedAt: new Date().toISOString(),
        tokensUsed:
          totalTokens > 0
            ? totalTokens
            : typeof result.tokensUsed === "number"
              ? result.tokensUsed
              : undefined,
        ...(totalTokens > 0
          ? {
              tokenUsage: { ...accumulated } as Record<string, unknown>,
            }
          : {}),
      });

      await appendExecutionLog(executionId, userId, orgId, "result", "result", null, result);
      await appendExecutionLog(executionId, userId, orgId, "system", "execution_completed", null, {
        executionId,
        status: "success",
      });
    } else {
      // Guard: don't overwrite "cancelled" status written by the cancel route
      if (signal.aborted) return;

      const duration = Date.now() - startTime;
      await updateExecution(executionId, {
        status: "failed",
        error: "No result returned from adapter",
        completedAt: new Date().toISOString(),
        duration,
        notifiedAt: new Date().toISOString(),
      });
      await appendExecutionLog(executionId, userId, orgId, "error", "execution_completed", null, {
        executionId,
        status: "failed",
        error: "No result returned from adapter",
      });
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
    await appendExecutionLog(executionId, userId, orgId, "error", "execution_completed", null, {
      executionId,
      status: "failed",
      error: errorMessage,
    });
  } finally {
    untrackExecution(executionId);
  }
}

// --- Router ---

export function createExecutionsRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/flows/:scope/:name/run — execute a flow (fire-and-forget, returns JSON)
  router.post("/flows/:scope{@[^/]+}/:name/run", rateLimit(20), requireFlow(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");
    const orgId = c.get("orgId");
    const packageId = flow.id;
    const profileIdOverride = c.req.query("profileId");

    // Run independent pre-flight operations in parallel
    const [serviceProfiles, config, userProfileId, inputResult] = await Promise.all([
      resolveServiceProfiles(
        flow.manifest.requires.services,
        user.id,
        packageId,
        orgId,
        profileIdOverride,
      ),
      getPackageConfig(orgId, packageId),
      profileIdOverride
        ? Promise.resolve(profileIdOverride)
        : getEffectiveProfileId(user.id, packageId),
      parseRequestInput(c, flow.manifest.input?.schema),
    ]);

    // Validate service dependencies (needs serviceProfiles)
    const depError = await validateFlowDependencies(
      flow.manifest.requires.services,
      serviceProfiles,
      orgId,
    );
    if (depError) {
      return c.json(depError, 400);
    }

    // Validate config
    const configSchema = flow.manifest.config?.schema ?? {
      type: "object" as const,
      properties: {},
    };
    const configValidation = validateConfig(config, configSchema);
    if (!configValidation.valid) {
      const first = configValidation.errors[0]!;
      return c.json(
        {
          error: "CONFIG_INCOMPLETE",
          message: `Parameter '${first.field}' is required`,
          configUrl: `/api/flows/${packageId}/config`,
        },
        400,
      );
    }

    if (!inputResult.ok) {
      return c.json(inputResult.error, inputResult.status);
    }
    const { input: parsedInput, uploadedFiles } = inputResult.data;

    // Version override from query param (e.g. ?version=1.2.0 or ?version=latest)
    const versionOverride = c.req.query("version");

    // If a specific version is requested, resolve and override flow data
    let effectiveFlow = flow;
    let overrideVersionId: number | undefined;
    if (versionOverride && flow.source !== "built-in") {
      const versionDetail = await getVersionDetail(flow.id, versionOverride);
      if (!versionDetail) {
        return c.json(
          { error: "VERSION_NOT_FOUND", message: `Version '${versionOverride}' not found` },
          404,
        );
      }
      overrideVersionId = versionDetail.id;
      // Override manifest and prompt on the flow object for this execution
      effectiveFlow = {
        ...flow,
        manifest: {
          ...flow.manifest,
          ...(versionDetail.manifest as typeof flow.manifest),
        },
        prompt: versionDetail.prompt ?? flow.prompt,
      };
    }

    const executionId = `exec_${crypto.randomUUID()}`;

    // Build file metadata for prompt context (no URLs — files injected directly into container)
    const fileRefs = uploadedFiles?.map((f) => ({
      fieldName: f.fieldName,
      name: f.name,
      type: f.type,
      size: f.size,
    }));

    // Build execution context (tokens, config, state, providers, package, version)
    const { promptContext, flowPackage, flowVersionId } = await buildExecutionContext({
      executionId,
      flow: effectiveFlow,
      serviceProfiles,
      orgId,
      userId: user.id,
      input: parsedInput,
      files: fileRefs,
      config,
      overrideVersionId,
    });

    // Create execution record
    await createExecution(
      executionId,
      packageId,
      user.id,
      orgId,
      parsedInput ?? null,
      undefined,
      flowVersionId ?? undefined,
      userProfileId,
    );

    // Fire-and-forget background execution
    executeFlowInBackground(
      executionId,
      user.id,
      orgId,
      effectiveFlow,
      promptContext,
      flowPackage,
      uploadedFiles,
    ).catch((err) => {
      logger.error("Unhandled error in background execution", {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return c.json({ executionId });
  });

  // GET /api/flows/:scope/:name/executions — list executions for a flow
  router.get("/flows/:scope{@[^/]+}/:name/executions", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const orgId = c.get("orgId");
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10) || 50, 100);
    const rows = await listPackageExecutions(flow.id, orgId, limit);
    return c.json(rows);
  });

  // GET /api/executions/:id — get a single execution
  router.get("/executions/:id", async (c) => {
    const execId = c.req.param("id");
    const orgId = c.get("orgId");
    const row = await getExecutionFull(execId);
    if (!row || row.orgId !== orgId) {
      return c.json({ error: "NOT_FOUND", message: "Execution not found" }, 404);
    }
    return c.json(row);
  });

  // GET /api/executions/:id/logs — get execution logs
  router.get("/executions/:id/logs", async (c) => {
    const execId = c.req.param("id");
    const orgId = c.get("orgId");
    const exec = await getExecution(execId);
    if (!exec || exec.orgId !== orgId) {
      return c.json({ error: "NOT_FOUND", message: "Execution not found" }, 404);
    }
    const logs = await listExecutionLogs(execId, orgId);
    return c.json(logs);
  });

  // POST /api/executions/:id/cancel — cancel a running/pending execution
  router.post("/executions/:id/cancel", async (c) => {
    const execId = c.req.param("id");
    const user = c.get("user");
    const orgId = c.get("orgId");

    const execution = await getExecution(execId);
    if (!execution) {
      return c.json({ error: "EXECUTION_NOT_FOUND", message: "Execution not found" }, 404);
    }

    // Verify ownership (same org)
    if (execution.orgId !== orgId) {
      return c.json({ error: "UNAUTHORIZED", message: "Not authorized" }, 403);
    }

    // Verify cancellable
    if (execution.status !== "pending" && execution.status !== "running") {
      return c.json(
        { error: "NOT_CANCELLABLE", message: "This execution cannot be cancelled" },
        409,
      );
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
    await appendExecutionLog(execId, user.id, orgId, "system", "execution_completed", null, {
      executionId: execId,
      status: "cancelled",
    });

    // Abort in-flight fetch calls immediately, then stop the container as backup
    abortExecution(execId);
    stopContainer(`appstrate-pi-${execId}`).catch(() => {});

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
        return c.json(
          { error: "EXECUTION_IN_PROGRESS", message: `${running} execution(s) still running` },
          409,
        );
      }

      const deleted = await deletePackageExecutions(flow.id, orgId);
      return c.json({ deleted });
    },
  );

  return router;
}
