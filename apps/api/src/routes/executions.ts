import { Hono } from "hono";
import { logger } from "../lib/logger.ts";
import type { LoadedFlow, AppEnv } from "../types/index.ts";
import {
  getFlowConfig,
  getLastExecutionState,
  createExecution,
  updateExecution,
  appendExecutionLog,
  getAdminConnections,
  getExecution,
  hasCustomCredentials,
} from "../services/state.ts";
import { listConnections, getAccessToken, getConnectionStatus } from "../services/nango.ts";
import {
  getAdapter,
  getAdapterName,
  TimeoutError,
  buildRetryPrompt,
} from "../services/adapters/index.ts";
import type { TokenUsage, FileReference } from "../services/adapters/index.ts";
import type { UploadedFile, PromptContext } from "../services/adapters/types.ts";
import { uploadExecutionFiles, cleanupExecutionFiles } from "../services/file-storage.ts";
import { buildPromptContext, buildExecutionApi } from "../services/env-builder.ts";
import { getFlowPackage } from "../services/flow-package.ts";
import {
  validateConfig,
  validateInput,
  validateOutput,
  validateFileInputs,
  schemaHasFileFields,
  parseFormDataFiles,
} from "../services/schema.ts";
import { getLatestVersionId } from "../services/flow-versions.ts";
import { trackExecution, untrackExecution, abortExecution } from "../services/execution-tracker.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requireFlow } from "../middleware/guards.ts";
import { stopContainer } from "../services/docker.ts";

const MIN_RETRY_TIME_MS = 5_000;

function accumulateUsage(total: TokenUsage, addition: TokenUsage): void {
  total.input_tokens += addition.input_tokens;
  total.output_tokens += addition.output_tokens;
  total.cache_creation_input_tokens =
    (total.cache_creation_input_tokens ?? 0) + (addition.cache_creation_input_tokens ?? 0);
  total.cache_read_input_tokens =
    (total.cache_read_input_tokens ?? 0) + (addition.cache_read_input_tokens ?? 0);
  if (addition.cost_usd != null) {
    total.cost_usd = (total.cost_usd ?? 0) + addition.cost_usd;
  }
}

// --- Background execution (decoupled from client) ---

export async function executeFlowInBackground(
  executionId: string,
  flowId: string,
  userId: string,
  orgId: string,
  flow: LoadedFlow,
  promptContext: PromptContext,
  flowPackage?: Buffer | null,
) {
  const startTime = Date.now();
  const controller = trackExecution(executionId);
  const { signal } = controller;

  try {
    // Emit execution_started
    await appendExecutionLog(executionId, userId, orgId, "system", "execution_started", null, {
      executionId,
      startedAt: new Date().toISOString(),
    });

    // Check dependencies
    const depCheck: Record<string, string> = {};
    for (const svc of flow.manifest.requires.services) {
      depCheck[svc.id] = promptContext.tokens[svc.id] ? "ok" : "missing";
    }
    await appendExecutionLog(executionId, userId, orgId, "system", "dependency_check", null, {
      services: depCheck,
    });

    // Update status to running
    await updateExecution(executionId, { status: "running" });

    // Execute via adapter
    const adapter = getAdapter();
    const adapterName = getAdapterName();
    await appendExecutionLog(executionId, userId, orgId, "system", "adapter_started", null, {
      adapter: adapterName,
    });

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
          completed_at: new Date().toISOString(),
          duration,
          ...(totalTokens > 0
            ? {
                tokens_used: totalTokens,
                token_usage: { ...accumulated } as Record<string, unknown>,
                cost_usd: accumulated.cost_usd,
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
      await updateExecution(executionId, {
        status: "success",
        result,
        ...(resultState ? { state: resultState } : {}),
        completed_at: new Date().toISOString(),
        duration,
        tokens_used:
          totalTokens > 0
            ? totalTokens
            : typeof result.tokensUsed === "number"
              ? result.tokensUsed
              : undefined,
        ...(totalTokens > 0
          ? {
              token_usage: { ...accumulated } as Record<string, unknown>,
              cost_usd: accumulated.cost_usd,
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
        completed_at: new Date().toISOString(),
        duration,
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
      completed_at: new Date().toISOString(),
      duration,
    });
    await appendExecutionLog(executionId, userId, orgId, "error", "execution_completed", null, {
      executionId,
      status: "failed",
      error: errorMessage,
    });
  } finally {
    untrackExecution(executionId);
    if (promptContext.files?.length) {
      cleanupExecutionFiles(executionId).catch((err) => {
        logger.warn("Failed to cleanup execution files", {
          executionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
}

// --- Router ---

export function createExecutionsRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/flows/:id/run — execute a flow (fire-and-forget, returns JSON)
  router.post("/flows/:id/run", rateLimit(20), requireFlow(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");
    const orgId = c.get("orgId");
    const flowId = flow.id;

    // Validate service dependencies
    const adminConns = await getAdminConnections(orgId, flowId);
    const connections = await listConnections(orgId, user.id);
    const connectedProviders = new Set(connections.map((c) => c.provider));

    for (const svc of flow.manifest.requires.services) {
      const mode = svc.connectionMode ?? "user";

      if (svc.provider === "custom") {
        // Custom service — check custom_service_credentials
        if (mode === "admin") {
          const adminUserId = adminConns[svc.id];
          if (!adminUserId) {
            return c.json(
              {
                error: "DEPENDENCY_NOT_SATISFIED",
                message: `Le connecteur '${svc.id}' n'est pas lie par un administrateur`,
              },
              400,
            );
          }
          const hasCreds = await hasCustomCredentials(orgId, adminUserId, flowId, svc.id);
          if (!hasCreds) {
            return c.json(
              {
                error: "DEPENDENCY_NOT_SATISFIED",
                message: `Les credentials admin pour '${svc.id}' ne sont plus disponibles`,
              },
              400,
            );
          }
        } else {
          const hasCreds = await hasCustomCredentials(orgId, user.id, flowId, svc.id);
          if (!hasCreds) {
            return c.json(
              {
                error: "DEPENDENCY_NOT_SATISFIED",
                message: `Le connecteur '${svc.id}' n'est pas configure`,
              },
              400,
            );
          }
        }
      } else if (mode === "admin") {
        const adminUserId = adminConns[svc.id];
        if (!adminUserId) {
          return c.json(
            {
              error: "DEPENDENCY_NOT_SATISFIED",
              message: `Le connecteur '${svc.id}' n'est pas lie par un administrateur`,
            },
            400,
          );
        }
        const conn = await getConnectionStatus(svc.provider, orgId, adminUserId);
        if (conn.status !== "connected") {
          return c.json(
            {
              error: "DEPENDENCY_NOT_SATISFIED",
              message: `La connexion admin pour '${svc.id}' n'est plus active`,
            },
            400,
          );
        }
      } else {
        if (!connectedProviders.has(svc.provider)) {
          return c.json(
            {
              error: "DEPENDENCY_NOT_SATISFIED",
              message: `Le connecteur '${svc.id}' n'est pas connecte`,
              connectUrl: `/auth/connect/${svc.provider}`,
            },
            400,
          );
        }
      }
    }

    // Validate config
    const config = await getFlowConfig(orgId, flowId);
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
          message: `Le parametre '${first.field}' est requis`,
          configUrl: `/api/flows/${flowId}/config`,
        },
        400,
      );
    }

    const inputSchema = flow.manifest.input?.schema;
    const hasFileFields = schemaHasFileFields(inputSchema);

    let body: { input?: Record<string, unknown> };
    let uploadedFiles: UploadedFile[] | undefined;

    if (hasFileFields) {
      try {
        const formData = await c.req.formData();
        const parsed = await parseFormDataFiles(formData, inputSchema!);
        body = { input: parsed.input };
        uploadedFiles = parsed.files;
      } catch (err) {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: `Erreur de parsing FormData: ${err instanceof Error ? err.message : String(err)}`,
          },
          400,
        );
      }

      if (uploadedFiles.length > 0) {
        const fileValidation = validateFileInputs(uploadedFiles, inputSchema!);
        if (!fileValidation.valid) {
          const first = fileValidation.errors[0]!;
          return c.json(
            { error: "VALIDATION_ERROR", message: first.message, field: first.field },
            400,
          );
        }
      }
    } else {
      try {
        body = await c.req.json<{ input?: Record<string, unknown> }>();
      } catch {
        body = {};
      }
    }

    // Validate required input fields (non-file fields)
    if (inputSchema) {
      const inputValidation = validateInput(body.input, inputSchema);
      if (!inputValidation.valid) {
        const first = inputValidation.errors[0]!;
        return c.json({ error: "INPUT_REQUIRED", message: first.message, field: first.field }, 400);
      }
    }

    const executionId = `exec_${crypto.randomUUID()}`;

    // Upload files to Supabase Storage and get signed URLs
    let fileRefs: FileReference[] | undefined;
    if (uploadedFiles && uploadedFiles.length > 0) {
      try {
        fileRefs = await uploadExecutionFiles(executionId, uploadedFiles);
      } catch (err) {
        return c.json(
          {
            error: "FILE_UPLOAD_FAILED",
            message: `Echec de l'upload des fichiers: ${err instanceof Error ? err.message : String(err)}`,
          },
          500,
        );
      }
    }

    // Get previous state and tokens (resolve based on connectionMode)
    const previousState = await getLastExecutionState(flowId, user.id, orgId);
    const tokens: Record<string, string> = {};
    for (const svc of flow.manifest.requires.services) {
      const mode = svc.connectionMode ?? "user";
      if (svc.provider === "custom") {
        // For custom services, tokens is a boolean marker — actual credentials resolved at runtime
        tokens[svc.id] = "custom";
      } else {
        const tokenUserId = mode === "admin" ? adminConns[svc.id] : user.id;
        if (tokenUserId) {
          const token = await getAccessToken(svc.provider, orgId, tokenUserId);
          if (token) tokens[svc.id] = token;
        }
      }
    }

    // Build prompt context
    const promptContext = buildPromptContext({
      flow,
      tokens,
      config,
      previousState,
      executionApi: buildExecutionApi(executionId),
      input: body.input,
      files: fileRefs,
    });

    // Get flow package (ZIP) for injection into container
    const flowPackage = await getFlowPackage(flow, orgId);

    // Get flow version ID for user flows (non-blocking on failure)
    const flowVersionId =
      flow.source === "user" ? await getLatestVersionId(flowId).catch(() => null) : null;

    // Create execution record
    await createExecution(
      executionId,
      flowId,
      user.id,
      orgId,
      body.input ?? null,
      undefined,
      flowVersionId ?? undefined,
    );

    // Fire-and-forget background execution
    executeFlowInBackground(
      executionId,
      flowId,
      user.id,
      orgId,
      flow,
      promptContext,
      flowPackage,
    ).catch((err) => {
      logger.error("Unhandled error in background execution", {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return c.json({ executionId });
  });

  // POST /api/executions/:id/cancel — cancel a running/pending execution
  router.post("/executions/:id/cancel", async (c) => {
    const execId = c.req.param("id");
    const user = c.get("user");
    const orgId = c.get("orgId");

    const execution = await getExecution(execId);
    if (!execution) {
      return c.json({ error: "EXECUTION_NOT_FOUND", message: "Execution introuvable" }, 404);
    }

    // Verify ownership (same org)
    if (execution.org_id !== orgId) {
      return c.json({ error: "UNAUTHORIZED", message: "Non autorise" }, 403);
    }

    // Verify cancellable
    if (execution.status !== "pending" && execution.status !== "running") {
      return c.json(
        { error: "NOT_CANCELLABLE", message: "Cette execution ne peut pas etre annulee" },
        409,
      );
    }

    // Update DB
    const now = new Date().toISOString();
    await updateExecution(execId, {
      status: "cancelled",
      error: "Cancelled by user",
      completed_at: now,
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

  return router;
}
