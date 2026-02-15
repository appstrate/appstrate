import Handlebars from "handlebars";
import { Hono } from "hono";
import { logger } from "../lib/logger.ts";
import type { LoadedFlow, AppEnv } from "../types/index.ts";
import {
  getFlowConfig,
  getFlowState,
  setFlowState,
  createExecution,
  updateExecution,
  appendExecutionLog,
} from "../services/state.ts";
import { listConnections, getAccessToken } from "../services/nango.ts";
import { getAdapter, getAdapterName, TimeoutError } from "../services/adapters/index.ts";
import { buildRetryPrompt } from "../services/adapters/claude-code.ts";
import { buildContainerEnv } from "../services/env-builder.ts";
import { validateConfig, validateInput, validateOutput } from "../services/schema.ts";
import { getLatestVersionId } from "../services/flow-versions.ts";
import { trackExecution, untrackExecution } from "../services/execution-tracker.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { requireFlow } from "../middleware/guards.ts";

const MIN_RETRY_TIME_MS = 5_000;

// --- Background execution (decoupled from client) ---

export async function executeFlowInBackground(
  executionId: string,
  flowId: string,
  userId: string,
  flow: LoadedFlow,
  envVars: Record<string, string>,
  tokens: Record<string, string>,
) {
  const startTime = Date.now();
  trackExecution(executionId);

  try {
    // Emit execution_started
    await appendExecutionLog(executionId, userId, "system", "execution_started", null, {
      executionId,
      startedAt: new Date().toISOString(),
    });

    // Check dependencies
    const depCheck: Record<string, string> = {};
    for (const svc of flow.manifest.requires.services) {
      depCheck[svc.id] = tokens[svc.id] ? "ok" : "missing";
    }
    await appendExecutionLog(executionId, userId, "system", "dependency_check", null, {
      services: depCheck,
    });

    // Update status to running
    await updateExecution(executionId, { status: "running" });

    // Execute via adapter
    const adapter = getAdapter();
    const adapterName = getAdapterName();
    await appendExecutionLog(executionId, userId, "system", "adapter_started", null, {
      adapter: adapterName,
    });

    const timeout = flow.manifest.execution?.timeout ?? 300;
    let result: Record<string, unknown> | null = null;

    try {
      for await (const msg of adapter.execute(
        executionId,
        envVars,
        timeout,
        flow.manifest.output?.schema,
      )) {
        if (msg.type === "progress") {
          await appendExecutionLog(
            executionId,
            userId,
            "progress",
            "progress",
            msg.message ?? null,
            null,
          );
        } else if (msg.type === "result") {
          result = msg.data ?? null;
        }
      }
    } catch (err) {
      if (err instanceof TimeoutError) {
        const duration = Date.now() - startTime;
        await updateExecution(executionId, {
          status: "timeout",
          error: `Execution timed out after ${timeout}s`,
          completed_at: new Date().toISOString(),
          duration,
        });
        await appendExecutionLog(executionId, userId, "error", "execution_completed", null, {
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
          await appendExecutionLog(executionId, userId, "system", "output_validation_retry", null, {
            attempt,
            maxRetries,
            errors: outputValidation.errors,
          });

          const retryPrompt = buildRetryPrompt(result, outputValidation.errors, outputSchema);
          const retryEnvVars: Record<string, string> = { FLOW_PROMPT: retryPrompt };
          if (envVars.LLM_MODEL) retryEnvVars.LLM_MODEL = envVars.LLM_MODEL;

          try {
            for await (const msg of adapter.execute(
              executionId,
              retryEnvVars,
              Math.min(60, Math.floor(remaining / 1000)),
              outputSchema,
            )) {
              if (msg.type === "progress") {
                await appendExecutionLog(
                  executionId,
                  userId,
                  "progress",
                  "progress",
                  msg.message ?? null,
                  null,
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
          await appendExecutionLog(executionId, userId, "system", "output_validation", null, {
            valid: false,
            errors: outputValidation.errors,
          });
          logger.warn("Output validation failed", {
            executionId,
            errors: outputValidation.errors,
          });
        }
      }

      const duration = Date.now() - startTime;
      await updateExecution(executionId, {
        status: "success",
        result,
        completed_at: new Date().toISOString(),
        duration,
        tokens_used: typeof result.tokensUsed === "number" ? result.tokensUsed : undefined,
      });

      // Update flow state if result includes state
      if (result.state && typeof result.state === "object") {
        await setFlowState(userId, flowId, result.state as Record<string, unknown>);
      }

      await appendExecutionLog(executionId, userId, "result", "result", null, result);
      await appendExecutionLog(executionId, userId, "system", "execution_completed", null, {
        executionId,
        status: "success",
      });
    } else {
      const duration = Date.now() - startTime;
      await updateExecution(executionId, {
        status: "failed",
        error: "No result returned from adapter",
        completed_at: new Date().toISOString(),
        duration,
      });
      await appendExecutionLog(executionId, userId, "error", "execution_completed", null, {
        executionId,
        status: "failed",
        error: "No result returned from adapter",
      });
    }
  } catch (err) {
    const duration = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    await updateExecution(executionId, {
      status: "failed",
      error: errorMessage,
      completed_at: new Date().toISOString(),
      duration,
    });
    await appendExecutionLog(executionId, userId, "error", "execution_completed", null, {
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

  // POST /api/flows/:id/run — execute a flow (fire-and-forget, returns JSON)
  router.post("/flows/:id/run", rateLimit(20), requireFlow(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");
    const flowId = flow.id;

    // Validate service dependencies (single Nango call for all services)
    const connections = await listConnections(user.id);
    const connectedProviders = new Set(connections.map((c) => c.provider));
    for (const svc of flow.manifest.requires.services) {
      if (!connectedProviders.has(svc.provider)) {
        return c.json(
          {
            error: "DEPENDENCY_NOT_SATISFIED",
            message: `Le service '${svc.id}' n'est pas connecte`,
            connectUrl: `/auth/connect/${svc.provider}`,
          },
          400,
        );
      }
    }

    // Validate config
    const config = await getFlowConfig(flowId);
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

    let body: { input?: Record<string, unknown> };
    try {
      body = await c.req.json<{ input?: Record<string, unknown> }>();
    } catch {
      body = {};
    }

    // Validate required input fields
    const inputSchema = flow.manifest.input?.schema;
    if (inputSchema) {
      const inputValidation = validateInput(body.input, inputSchema);
      if (!inputValidation.valid) {
        const first = inputValidation.errors[0]!;
        return c.json({ error: "INPUT_REQUIRED", message: first.message, field: first.field }, 400);
      }
    }

    const executionId = `exec_${crypto.randomUUID()}`;

    // Get state and tokens
    const state = await getFlowState(user.id, flowId);
    const tokens: Record<string, string> = {};
    for (const svc of flow.manifest.requires.services) {
      const token = await getAccessToken(svc.provider, user.id);
      if (token) tokens[svc.id] = token;
    }

    // Interpolate prompt
    const input = body.input ?? {};
    const prompt = interpolatePrompt(flow.prompt, config, state, input);

    // Prepare env vars for container
    const envVars = buildContainerEnv({
      flowId,
      executionId,
      prompt,
      tokens,
      config,
      state,
      input: body.input,
      skills: flow.skills.filter((s) => s.content).map((s) => ({ id: s.id, content: s.content! })),
    });

    // Get flow version ID for user flows (non-blocking on failure)
    const flowVersionId =
      flow.source === "user" ? await getLatestVersionId(flowId).catch(() => null) : null;

    // Create execution record
    await createExecution(
      executionId,
      flowId,
      user.id,
      body.input ?? null,
      undefined,
      flowVersionId ?? undefined,
    );

    // Fire-and-forget background execution
    executeFlowInBackground(executionId, flowId, user.id, flow, envVars, tokens).catch((err) => {
      logger.error("Unhandled error in background execution", {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return c.json({ executionId });
  });

  return router;
}

export function interpolatePrompt(
  prompt: string,
  config: Record<string, unknown>,
  state: Record<string, unknown>,
  input: Record<string, unknown> = {},
): string {
  const template = Handlebars.compile(prompt, { noEscape: true });
  return template({ config, state, input });
}
