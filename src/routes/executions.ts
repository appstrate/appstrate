import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { LoadedFlow } from "../types/index.ts";
import {
  getFlowConfig,
  getFlowState,
  setFlowState,
  createExecution,
  updateExecution,
  getExecution,
  getExecutionsByFlow,
  appendExecutionLog,
  getExecutionLogs,
} from "../services/state.ts";
import { getConnectionStatus, getAccessToken } from "../services/nango.ts";
import { getAdapter, getAdapterName, TimeoutError } from "../services/adapters/index.ts";
import { broadcast } from "../ws.ts";

// --- In-memory pub/sub for live log streaming ---

type LogEntry = { id: number; event: string; data: unknown };
type LogCallback = (log: LogEntry) => void;
const liveSubscribers = new Map<string, Set<LogCallback>>();

function subscribe(executionId: string, cb: LogCallback): () => void {
  if (!liveSubscribers.has(executionId)) {
    liveSubscribers.set(executionId, new Set());
  }
  liveSubscribers.get(executionId)!.add(cb);
  return () => {
    const subs = liveSubscribers.get(executionId);
    if (subs) {
      subs.delete(cb);
      if (subs.size === 0) liveSubscribers.delete(executionId);
    }
  };
}

function notifySubscribers(executionId: string, log: LogEntry) {
  const subs = liveSubscribers.get(executionId);
  if (subs) {
    for (const cb of subs) cb(log);
  }
}

// --- Persist a log entry and broadcast to subscribers ---

async function emitLog(
  executionId: string,
  type: string,
  event: string,
  message: string | null,
  data: Record<string, unknown> | null,
  flowId?: string
) {
  const id = await appendExecutionLog(executionId, type, event, message, data);
  notifySubscribers(executionId, { id, event, data: data ?? (message ? { message } : {}) });

  // Broadcast via WebSocket
  broadcast(`execution:${executionId}`, {
    type: "log",
    executionId,
    event,
    data: data ?? (message ? { message } : {}),
  });

  if (flowId && (event === "execution_started" || event === "execution_completed")) {
    const stateMsg = { type: event, flowId, executionId, ...(data || {}) };
    broadcast(`flow:${flowId}`, stateMsg);
    broadcast("flows", stateMsg);
  }
}

// --- Shared SSE streaming logic ---

async function streamLogsToSSE(
  stream: { writeSSE: (data: { event: string; data: string }) => Promise<void>; sleep: (ms: number) => Promise<void> },
  executionId: string,
  initialDelayMs: number = 0
) {
  if (initialDelayMs > 0) await stream.sleep(initialDelayMs);

  // Replay existing logs from DB
  const existingLogs = await getExecutionLogs(executionId);
  for (const log of existingLogs) {
    await stream.writeSSE({
      event: log.event ?? "progress",
      data: JSON.stringify(log.data ?? { message: log.message }),
    });
  }

  // Check if already finished
  const exec = await getExecution(executionId);
  if (exec && ["success", "failed", "timeout"].includes(exec.status as string)) return;

  // Subscribe to live updates
  let closed = false;
  const unsubscribe = subscribe(executionId, async (log) => {
    if (closed) return;
    try {
      await stream.writeSSE({ event: log.event, data: JSON.stringify(log.data) });
      if (log.event === "execution_completed") closed = true;
    } catch {
      closed = true;
    }
  });

  while (!closed) {
    await stream.sleep(2000);
    const current = await getExecution(executionId);
    if (current && ["success", "failed", "timeout"].includes(current.status as string)) break;
  }

  unsubscribe();
}

// --- Background execution (decoupled from SSE) ---

async function executeFlowInBackground(
  executionId: string,
  flowId: string,
  flow: LoadedFlow,
  envVars: Record<string, string>,
  tokens: Record<string, string>
) {
  const startTime = Date.now();

  try {
    // Emit execution_started
    await emitLog(executionId, "system", "execution_started", null, {
      executionId,
      startedAt: new Date().toISOString(),
    }, flowId);

    // Check dependencies
    const depCheck: Record<string, string> = {};
    for (const svc of flow.manifest.requires.services) {
      depCheck[svc.id] = tokens[svc.id] ? "ok" : "missing";
    }
    await emitLog(executionId, "system", "dependency_check", null, { services: depCheck }, flowId);

    // Update status to running
    await updateExecution(executionId, { status: "running" });

    // Execute via adapter
    const adapter = getAdapter();
    const adapterName = getAdapterName();
    await emitLog(executionId, "system", "adapter_started", null, { adapter: adapterName }, flowId);

    const timeout = flow.manifest.execution?.timeout ?? 300;
    let result: Record<string, unknown> | null = null;

    try {
      for await (const msg of adapter.execute(executionId, envVars, flow.path, timeout)) {
        if (msg.type === "progress") {
          await emitLog(executionId, "progress", "progress", msg.message ?? null, null, flowId);
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
        await emitLog(executionId, "error", "execution_completed", null, {
          executionId,
          status: "timeout",
        }, flowId);
        return;
      }
      throw err;
    }

    if (result) {
      const duration = Date.now() - startTime;
      await updateExecution(executionId, {
        status: "success",
        result,
        completed_at: new Date().toISOString(),
        duration,
        tokens_used: (result as Record<string, unknown>).tokensUsed as number | undefined,
      });

      // Update flow state if result includes state
      if (result.state && typeof result.state === "object") {
        await setFlowState(flowId, result.state as Record<string, unknown>);
      }

      await emitLog(executionId, "result", "result", null, result, flowId);
      await emitLog(executionId, "system", "execution_completed", null, {
        executionId,
        status: "success",
      }, flowId);
    } else {
      const duration = Date.now() - startTime;
      await updateExecution(executionId, {
        status: "failed",
        error: "No result returned from adapter",
        completed_at: new Date().toISOString(),
        duration,
      });
      await emitLog(executionId, "error", "execution_completed", null, {
        executionId,
        status: "failed",
        error: "No result returned from adapter",
      }, flowId);
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
    await emitLog(executionId, "error", "execution_completed", null, {
      executionId,
      status: "failed",
      error: errorMessage,
    }, flowId);
  }
}

// --- Router ---

export function createExecutionsRouter(flows: Map<string, LoadedFlow>) {
  const router = new Hono();

  // POST /api/flows/:id/run — execute a flow (concurrent, fire-and-forget)
  router.post("/flows/:id/run", async (c) => {
    const flowId = c.req.param("id");
    const flow = flows.get(flowId);

    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: `Flow '${flowId}' not found` }, 404);
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

    const body = await c.req
      .json<{ input?: Record<string, unknown>; stream?: boolean }>()
      .catch(() => ({} as { input?: Record<string, unknown>; stream?: boolean }));

    // Validate required input fields
    const inputSchema = flow.manifest.input?.schema;
    if (inputSchema) {
      for (const [key, field] of Object.entries(inputSchema)) {
        if (
          field.required &&
          (!body.input || body.input[key] === undefined || body.input[key] === null || body.input[key] === "")
        ) {
          return c.json(
            {
              error: "INPUT_REQUIRED",
              message: `Le champ d'entrée '${key}' est requis`,
              field: key,
            },
            400
          );
        }
      }
    }

    const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Get state and tokens
    const state = await getFlowState(flowId);
    const tokens: Record<string, string> = {};
    for (const svc of flow.manifest.requires.services) {
      const token = await getAccessToken(svc.provider);
      if (token) tokens[svc.id] = token;
    }

    // Interpolate prompt
    const input = body.input ?? {};
    const prompt = interpolatePrompt(flow.prompt, config, state, input);

    // Prepare env vars for container
    const envVars: Record<string, string> = {
      FLOW_PROMPT: prompt,
      FLOW_ID: flowId,
      EXECUTION_ID: executionId,
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

    // Inject input
    if (body.input) {
      for (const [key, value] of Object.entries(body.input)) {
        envVars[`INPUT_${key.toUpperCase()}`] = String(value);
      }
    }

    // Create execution record
    await createExecution(executionId, flowId, body.input ?? null);

    // Fire-and-forget background execution
    executeFlowInBackground(executionId, flowId, flow, envVars, tokens);

    // stream: false → return JSON with executionId
    if (body.stream === false) {
      return c.json({ executionId });
    }

    // Default: return SSE stream that subscribes to logs (replay + live)
    return streamSSE(c, async (stream) => {
      try {
        await streamLogsToSSE(stream, executionId, 50);
      } catch {
        // Client disconnected — execution continues in background
      }
    });
  });

  // GET /api/flows/:id/executions — list past executions
  router.get("/flows/:id/executions", async (c) => {
    const flowId = c.req.param("id");
    const limit = Math.min(Number(c.req.query("limit")) || 50, 100);
    const flow = flows.get(flowId);
    if (!flow) return c.json({ error: "FLOW_NOT_FOUND" }, 404);
    const executions = await getExecutionsByFlow(flowId, limit);
    return c.json({ flowId, executions });
  });

  // GET /api/executions/:id/logs — get persisted logs for an execution
  router.get("/executions/:id/logs", async (c) => {
    const executionId = c.req.param("id");
    const after = c.req.query("after") ? Number(c.req.query("after")) : undefined;
    const limit = Math.min(Number(c.req.query("limit")) || 1000, 5000);

    const execution = await getExecution(executionId);
    if (!execution) {
      return c.json({ error: "NOT_FOUND", message: `Execution '${executionId}' not found` }, 404);
    }

    const logs = await getExecutionLogs(executionId, after, limit);
    const hasMore = logs.length === limit;

    return c.json({
      executionId,
      status: execution.status,
      logs,
      hasMore,
    });
  });

  // GET /api/executions/:id/stream — SSE stream (replay + live)
  router.get("/executions/:id/stream", async (c) => {
    const executionId = c.req.param("id");

    const execution = await getExecution(executionId);
    if (!execution) {
      return c.json({ error: "NOT_FOUND", message: `Execution '${executionId}' not found` }, 404);
    }

    return streamSSE(c, async (stream) => {
      try {
        await streamLogsToSSE(stream, executionId);
      } catch {
        // Client disconnected
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
  state: Record<string, unknown>,
  input: Record<string, unknown> = {}
): string {
  let result = prompt;

  // Replace {{input.*}}
  result = result.replace(/\{\{input\.(\w+)\}\}/g, (_, key) => {
    return String(input[key] ?? "");
  });

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
  result = result.replace(/\{\{#if state\.(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, ifBlock) => {
    return state[key] ? ifBlock : "";
  });

  return result;
}
