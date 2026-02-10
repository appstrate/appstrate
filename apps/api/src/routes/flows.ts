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
import { getConnectionStatus } from "../services/nango.ts";

export function createFlowsRouter(flows: Map<string, LoadedFlow>) {
  const router = new Hono();

  // GET /api/flows — list all loaded flows
  router.get("/", async (c) => {
    const runningCounts = await getRunningExecutionsCounts();

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
      },
      runningExecutions: runningCounts[f.id] ?? 0,
    }));

    return c.json({ flows: flowList });
  });

  // GET /api/flows/:id — flow detail with dependency status
  router.get("/:id", async (c) => {
    const flowId = c.req.param("id");
    const flow = flows.get(flowId);

    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: `Flow '${flowId}' not found` }, 404);
    }

    const m = flow.manifest;

    // Check service connections in parallel
    const serviceStatuses = await Promise.all(
      m.requires.services.map(async (svc) => {
        const conn = await getConnectionStatus(svc.provider);
        return {
          id: svc.id,
          provider: svc.provider,
          description: svc.description,
          status: conn.status,
          // Connect URL is now obtained via POST /auth/connect/:provider (Connect Session Token flow)
        };
      }),
    );

    const toolStatuses = (m.requires.tools ?? []).map((t) => ({
      id: t.id,
      type: t.type,
      status: "available",
    }));

    // Get config, state, last execution, running count in parallel
    const [currentConfig, currentState, lastExec, runningCount] = await Promise.all([
      getFlowConfig(flowId),
      getFlowState(flowId),
      getLastExecution(flowId),
      getRunningExecutionsForFlow(flowId),
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
      requires: {
        services: serviceStatuses,
        tools: toolStatuses,
      },
      ...(m.input ? { input: { schema: m.input.schema } } : {}),
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
    });
  });

  // PUT /api/flows/:id/config — save flow configuration
  router.put("/:id/config", async (c) => {
    const flowId = c.req.param("id");
    const flow = flows.get(flowId);

    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: `Flow '${flowId}' not found` }, 404);
    }

    const body = await c.req.json<Record<string, unknown>>();
    const schema = flow.manifest.config?.schema ?? {};

    // Validate required fields
    const errors: { field: string; error: string }[] = [];
    for (const [key, field] of Object.entries(schema)) {
      if (field.required && (body[key] === undefined || body[key] === null)) {
        errors.push({ field: key, error: "Champ obligatoire manquant" });
      }
      if (body[key] !== undefined && field.enum && !field.enum.includes(body[key])) {
        errors.push({
          field: key,
          error: `Valeur invalide. Valeurs acceptées : ${field.enum.join(", ")}`,
        });
      }
    }

    if (errors.length > 0) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "Configuration invalide", details: errors },
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

  // DELETE /api/flows/:id/state — reset flow state
  router.delete("/:id/state", async (c) => {
    const flowId = c.req.param("id");
    const flow = flows.get(flowId);

    if (!flow) {
      return c.json({ error: "FLOW_NOT_FOUND", message: `Flow '${flowId}' not found` }, 404);
    }

    await deleteFlowState(flowId);
    return c.body(null, 204);
  });

  return router;
}
