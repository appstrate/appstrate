import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { LoadedFlow } from "../types/index.ts";
import {
  getFlowConfig,
  getFlowState,
  createExecution,
  updateExecution,
  getExecution,
} from "../services/state.ts";
import { getConnectionStatus, getAccessToken } from "../services/nango.ts";
import { getAdapter, getAdapterName, TimeoutError, ClaudeCodeTimeoutError } from "../services/adapters/index.ts";

export function createExecutionsRouter(flows: Map<string, LoadedFlow>) {
  const router = new Hono();

  // Track running executions to prevent duplicates
  const runningExecutions = new Map<string, string>(); // flowId -> executionId

  // POST /api/flows/:id/run — execute a flow
  router.post("/flows/:id/run", async (c) => {
    const flowId = c.req.param("id");
    const flow = flows.get(flowId);

    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: `Flow '${flowId}' not found` }, 404);
    }

    // Check if already running
    if (runningExecutions.has(flowId)) {
      return c.json(
        {
          error: "EXECUTION_IN_PROGRESS",
          message: "Une exécution est déjà en cours pour ce flow",
          executionId: runningExecutions.get(flowId),
        },
        409
      );
    }

    // Validate service dependencies
    for (const svc of flow.manifest.requires.services) {
      const conn = await getConnectionStatus(svc.provider);
      if (conn.status !== "connected") {
        return c.json(
          {
            error: "DEPENDENCY_NOT_SATISFIED",
            message: `Le service '${svc.id}' n'est pas connecté`,
            connectUrl: `/auth/connect/${svc.provider}`,
          },
          400
        );
      }
    }

    // Validate config
    const config = await getFlowConfig(flowId);
    const schema = flow.manifest.config?.schema ?? {};
    for (const [key, field] of Object.entries(schema)) {
      if (field.required && (config[key] === undefined || config[key] === null)) {
        return c.json(
          {
            error: "CONFIG_INCOMPLETE",
            message: `Le paramètre '${key}' est requis`,
            configUrl: `/api/flows/${flowId}/config`,
          },
          400
        );
      }
    }

    const body = await c.req.json<{ input?: Record<string, unknown>; stream?: boolean }>().catch(() => ({}));
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Get state and tokens
    const state = await getFlowState(flowId);
    const tokens: Record<string, string> = {};
    for (const svc of flow.manifest.requires.services) {
      const token = await getAccessToken(svc.provider);
      if (token) tokens[svc.id] = token;
    }

    // Interpolate prompt
    const prompt = interpolatePrompt(flow.prompt, config, state);

    // Create execution record
    await createExecution(executionId, flowId, body.input ?? null);
    runningExecutions.set(flowId, executionId);

    const cleanup = () => {
      runningExecutions.delete(flowId);
    };

    // Stream SSE
    return streamSSE(c, async (stream) => {
      try {
        await stream.writeSSE({ event: "execution_started", data: JSON.stringify({ executionId, startedAt: new Date().toISOString() }) });

        // Check dependencies
        const depCheck: Record<string, string> = {};
        for (const svc of flow.manifest.requires.services) {
          depCheck[svc.id] = tokens[svc.id] ? "ok" : "missing";
        }
        await stream.writeSSE({ event: "dependency_check", data: JSON.stringify({ services: depCheck }) });

        // Update status to running
        await updateExecution(executionId, { status: "running" });

        // Prepare env vars for container
        const envVars: Record<string, string> = {
          FLOW_PROMPT: prompt,
          FLOW_ID: flowId,
          EXECUTION_ID: executionId,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
          LLM_MODEL: process.env.LLM_MODEL || "claude-sonnet-4-5-20250929",
        };

        // Inject OAuth tokens
        for (const [svcId, token] of Object.entries(tokens)) {
          envVars[`TOKEN_${svcId.toUpperCase()}`] = token;
        }

        // Inject config
        for (const [key, value] of Object.entries(config)) {
          envVars[`CONFIG_${key.toUpperCase()}`] = String(value);
        }

        // Inject state
        envVars["FLOW_STATE"] = JSON.stringify(state);

        // Execute via adapter (Docker or Claude Code CLI)
        const adapter = getAdapter();
        const adapterName = getAdapterName();
        await stream.writeSSE({ event: "adapter_started", data: JSON.stringify({ adapter: adapterName }) });

        const timeout = flow.manifest.execution?.timeout ?? 300;
        let result: Record<string, unknown> | null = null;

        try {
          for await (const msg of adapter.execute(executionId, envVars, flow.path, timeout)) {
            if (msg.type === "progress") {
              await stream.writeSSE({ event: "progress", data: JSON.stringify({ message: msg.message }) });
            } else if (msg.type === "result") {
              result = msg.data ?? null;
            }
          }
        } catch (err) {
          if (err instanceof TimeoutError || err instanceof ClaudeCodeTimeoutError) {
            await updateExecution(executionId, {
              status: "timeout",
              error: `Execution timed out after ${timeout}s`,
              completed_at: new Date().toISOString(),
            });
            await stream.writeSSE({
              event: "execution_completed",
              data: JSON.stringify({ executionId, status: "timeout" }),
            });
            return;
          }
          throw err;
        }

        if (result) {
          const completedAt = new Date().toISOString();
          await updateExecution(executionId, {
            status: "success",
            result,
            completed_at: completedAt,
            tokens_used: (result as Record<string, unknown>).tokensUsed as number | undefined,
          });

          // Update flow state if result includes state
          if (result.state && typeof result.state === "object") {
            const { setFlowState } = await import("../services/state.ts");
            await setFlowState(flowId, result.state as Record<string, unknown>);
          }

          await stream.writeSSE({ event: "result", data: JSON.stringify(result) });
          await stream.writeSSE({
            event: "execution_completed",
            data: JSON.stringify({ executionId, status: "success" }),
          });
          // Allow final SSE data to flush before Hono closes the stream
          await stream.sleep(100);
        } else {
          await updateExecution(executionId, {
            status: "failed",
            error: "No result returned from adapter",
            completed_at: new Date().toISOString(),
          });
          await stream.writeSSE({
            event: "execution_completed",
            data: JSON.stringify({ executionId, status: "failed" }),
          });
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Unknown error";
        await updateExecution(executionId, {
          status: "failed",
          error: errorMessage,
          completed_at: new Date().toISOString(),
        });
        await stream.writeSSE({
          event: "execution_completed",
          data: JSON.stringify({ executionId, status: "failed", error: errorMessage }),
        });
      } finally {
        cleanup();
      }
    });
  });

  // GET /api/executions/:id — get execution status
  router.get("/executions/:id", async (c) => {
    const executionId = c.req.param("id");
    const execution = await getExecution(executionId);

    if (!execution) {
      return c.json({ error: "NOT_FOUND", message: `Execution '${executionId}' not found` }, 404);
    }

    return c.json(execution);
  });

  return router;
}

function interpolatePrompt(
  prompt: string,
  config: Record<string, unknown>,
  state: Record<string, unknown>
): string {
  let result = prompt;

  // Replace {{config.*}}
  result = result.replace(/\{\{config\.(\w+)\}\}/g, (_, key) => {
    return String(config[key] ?? "");
  });

  // Replace {{state.*}}
  result = result.replace(/\{\{state\.(\w+)\}\}/g, (_, key) => {
    return String(state[key] ?? "");
  });

  // Handle {{#if state.*}} ... {{else}} ... {{/if}} blocks
  result = result.replace(
    /\{\{#if state\.(\w+)\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key, ifBlock, elseBlock) => {
      return state[key] ? ifBlock : elseBlock;
    }
  );

  // Handle {{#if state.*}} ... {{/if}} blocks (without else)
  result = result.replace(
    /\{\{#if state\.(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key, ifBlock) => {
      return state[key] ? ifBlock : "";
    }
  );

  return result;
}
