import { Hono } from "hono";
import type { LoadedFlow } from "../types/index.ts";
import {
  getFlowConfig,
  setFlowConfig,
  getFlowState,
  deleteFlowState,
  getLastExecution,
  getRunningExecutionsCounts,
  getRunningExecutionsForFlow,
} from "../services/state.ts";
import { getConnectionStatus, getProviderAuthMode } from "../services/nango.ts";
import { validateConfig } from "../services/schema.ts";
import { isAdmin } from "../lib/supabase.ts";
import { getFlowById } from "../services/user-flows.ts";

export function createFlowsRouter(flows: Map<string, LoadedFlow>) {
  const router = new Hono();

  // GET /api/flows — list all loaded flows
  router.get("/", async (c) => {
    const user = c.get("user") as { id: string };
    const runningCounts = await getRunningExecutionsCounts(user.id);

    const flowList = Array.from(flows.values()).map((f) => ({
      id: f.id,
      displayName: f.manifest.metadata.displayName,
      description: f.manifest.metadata.description,
      version: f.manifest.version,
      author: f.manifest.metadata.author,
      tags: f.manifest.metadata.tags ?? [],
      requires: {
        services: f.manifest.requires.services.map((s) => s.id),
        tools: (f.manifest.requires.tools ?? []).map((t) => t.id),
        skills: f.skills.map((s) => s.id),
      },
      runningExecutions: runningCounts[f.id] ?? 0,
      source: f.source,
    }));

    return c.json({ flows: flowList });
  });

  // GET /api/flows/:id — flow detail with dependency status
  router.get("/:id", async (c) => {
    const flowId = c.req.param("id");
    const flow = flows.get(flowId);
    const user = c.get("user") as { id: string };

    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: `Flow '${flowId}' not found` }, 404);
    }

    const m = flow.manifest;

    // Check service connections in parallel (per-user)
    const serviceStatuses = await Promise.all(
      m.requires.services.map(async (svc) => {
        const [conn, authMode] = await Promise.all([
          getConnectionStatus(svc.provider, user.id),
          getProviderAuthMode(svc.provider),
        ]);
        return {
          id: svc.id,
          provider: svc.provider,
          description: svc.description,
          status: conn.status,
          authMode,
        };
      }),
    );

    const toolStatuses = (m.requires.tools ?? []).map((t) => ({
      id: t.id,
      type: t.type,
      status: "available",
    }));

    // Get config (global), state (per-user), last execution (per-user), running count (per-user)
    // For user flows, also fetch the raw DB row for editable content
    const [currentConfig, currentState, lastExec, runningCount, userFlowRow] = await Promise.all([
      getFlowConfig(flowId),
      getFlowState(user.id, flowId),
      getLastExecution(flowId, user.id),
      getRunningExecutionsForFlow(flowId, user.id),
      flow.source === "user" ? getFlowById(flowId) : Promise.resolve(null),
    ]);

    // Merge defaults with current config
    const configWithDefaults: Record<string, unknown> = {};
    if (m.config?.schema) {
      for (const [key, field] of Object.entries(m.config.schema)) {
        configWithDefaults[key] = currentConfig[key] ?? field.default ?? null;
      }
    }

    return c.json({
      id: flow.id,
      displayName: m.metadata.displayName,
      description: m.metadata.description,
      version: m.version,
      author: m.metadata.author,
      source: flow.source,
      requires: {
        services: serviceStatuses,
        tools: toolStatuses,
        skills: flow.skills,
      },
      ...(m.input ? { input: { schema: m.input.schema } } : {}),
      ...(m.output ? { output: { schema: m.output.schema } } : {}),
      config: {
        schema: m.config?.schema ?? {},
        current: configWithDefaults,
      },
      state: currentState,
      runningExecutions: runningCount,
      lastExecution: lastExec
        ? {
            id: lastExec.id,
            status: lastExec.status,
            startedAt: lastExec.started_at,
            duration: lastExec.duration,
          }
        : null,
      ...(flow.source === "user" && userFlowRow
        ? {
            updatedAt: userFlowRow.updated_at,
            prompt: flow.prompt,
            rawSkills: userFlowRow.skills as
              | { id: string; description: string; content: string }[]
              | undefined,
          }
        : {}),
    });
  });

  // PUT /api/flows/:id/config — save flow configuration (admin-only)
  router.put("/:id/config", async (c) => {
    const flowId = c.req.param("id");
    const flow = flows.get(flowId);
    const user = c.get("user") as { id: string };

    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: `Flow '${flowId}' not found` }, 404);
    }

    // Admin check
    if (!(await isAdmin(user.id))) {
      return c.json(
        {
          error: "FORBIDDEN",
          message: "Seuls les administrateurs peuvent modifier la configuration",
        },
        403,
      );
    }

    const body = await c.req.json<Record<string, unknown>>();
    const schema = flow.manifest.config?.schema ?? {};

    // Validate config with Zod
    const validation = validateConfig(body, schema);
    if (!validation.valid) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "Configuration invalide",
          details: validation.errors.map((e) => ({ field: e.field, error: e.message })),
        },
        400,
      );
    }

    // Merge with defaults
    const config: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema)) {
      config[key] = body[key] ?? field.default ?? null;
    }

    await setFlowConfig(flowId, config);

    return c.json({
      config,
      validation: { valid: true },
    });
  });

  // DELETE /api/flows/:id/state — reset current user's flow state
  router.delete("/:id/state", async (c) => {
    const flowId = c.req.param("id");
    const flow = flows.get(flowId);
    const user = c.get("user") as { id: string };

    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: `Flow '${flowId}' not found` }, 404);
    }

    await deleteFlowState(user.id, flowId);
    return c.body(null, 204);
  });

  return router;
}
