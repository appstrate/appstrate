import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
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
import { getFlowById } from "../services/user-flows.ts";
import { listFlows } from "../services/flow-service.ts";
import { listFlowVersions } from "../services/flow-versions.ts";
import { getFlowPackage } from "../services/flow-package.ts";
import { requireAdmin, requireFlow } from "../middleware/guards.ts";

export function createFlowsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/flows — list all loaded flows
  router.get("/", async (c) => {
    const user = c.get("user");
    const [allFlows, runningCounts] = await Promise.all([
      listFlows(),
      getRunningExecutionsCounts(user.id),
    ]);

    const flowList = allFlows.map((f) => ({
      id: f.id,
      displayName: f.manifest.metadata.displayName,
      description: f.manifest.metadata.description,
      version: f.manifest.version,
      author: f.manifest.metadata.author,
      tags: f.manifest.metadata.tags ?? [],
      requires: {
        services: f.manifest.requires.services.map((s) => s.id),
        skills: f.skills.map((s) => s.id),
        extensions: f.extensions.map((e) => e.id),
      },
      runningExecutions: runningCounts[f.id] ?? 0,
      source: f.source,
    }));

    return c.json({ flows: flowList });
  });

  // GET /api/flows/:id — flow detail with dependency status
  router.get("/:id", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");
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

    // Get config (global), state (per-user), last execution (per-user), running count (per-user)
    // For user flows, also fetch the raw DB row for editable content
    const [currentConfig, currentState, lastExec, runningCount, userFlowRow] = await Promise.all([
      getFlowConfig(flow.id),
      getFlowState(user.id, flow.id),
      getLastExecution(flow.id, user.id),
      getRunningExecutionsForFlow(flow.id, user.id),
      flow.source === "user" ? getFlowById(flow.id) : Promise.resolve(null),
    ]);

    // Merge defaults with current config
    const configWithDefaults: Record<string, unknown> = {};
    if (m.config?.schema?.properties) {
      for (const [key, prop] of Object.entries(m.config.schema.properties)) {
        configWithDefaults[key] = currentConfig[key] ?? prop.default ?? null;
      }
    }

    return c.json({
      id: flow.id,
      displayName: m.metadata.displayName,
      description: m.metadata.description,
      version: m.version,
      author: m.metadata.author,
      tags: m.metadata.tags ?? [],
      source: flow.source,
      requires: {
        services: serviceStatuses,
        skills: flow.skills.map((s) => ({
          id: s.id,
          ...(s.name ? { name: s.name } : {}),
          ...(s.description ? { description: s.description } : {}),
        })),
        extensions: flow.extensions.map((e) => ({
          id: e.id,
          ...(e.name ? { name: e.name } : {}),
          ...(e.description ? { description: e.description } : {}),
        })),
      },
      ...(m.input ? { input: { schema: m.input.schema } } : {}),
      ...(m.output ? { output: { schema: m.output.schema } } : {}),
      config: {
        schema: m.config?.schema ?? { type: "object", properties: {} },
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
            stateSchema: m.state ?? null,
            executionSettings: m.execution ?? null,
          }
        : {}),
    });
  });

  // PUT /api/flows/:id/config — save flow configuration (admin-only)
  router.put("/:id/config", requireFlow(), requireAdmin(), async (c) => {
    const flow = c.get("flow");

    const body = await c.req.json<Record<string, unknown>>();
    const schema = flow.manifest.config?.schema ?? { type: "object" as const, properties: {} };

    // Validate config with AJV
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
    for (const [key, prop] of Object.entries(schema.properties)) {
      config[key] = body[key] ?? prop.default ?? null;
    }

    await setFlowConfig(flow.id, config);

    return c.json({
      config,
      validation: { valid: true },
    });
  });

  // GET /api/flows/:id/package — download the flow ZIP
  router.get("/:id/package", requireFlow(), async (c) => {
    const flow = c.get("flow");

    const zipBuffer = await getFlowPackage(flow);
    if (!zipBuffer) {
      return c.json({ error: "FLOW_NOT_FOUND", message: "Package introuvable" }, 404);
    }

    c.header("Content-Type", "application/zip");
    c.header("Content-Disposition", `attachment; filename="${flow.id}.zip"`);
    return c.body(new Uint8Array(zipBuffer));
  });

  // GET /api/flows/:id/versions — list flow version history (user flows only)
  router.get("/:id/versions", requireFlow(), async (c) => {
    const flow = c.get("flow");

    if (flow.source !== "user") {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: "Built-in flows do not have version history" },
        400,
      );
    }

    const versions = await listFlowVersions(flow.id);
    return c.json({
      versions: versions.map((v) => ({
        id: v.id,
        versionNumber: v.version_number,
        createdBy: v.created_by,
        createdAt: v.created_at,
      })),
    });
  });

  // DELETE /api/flows/:id/state — reset current user's flow state
  router.delete("/:id/state", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");

    await deleteFlowState(user.id, flow.id);
    return c.body(null, 204);
  });

  return router;
}
