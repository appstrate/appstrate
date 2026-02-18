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
  getAdminConnections,
  bindAdminConnection,
  unbindAdminConnection,
} from "../services/state.ts";
import { getConnectionStatus, resolveServiceStatuses } from "../services/nango.ts";
import { validateConfig } from "../services/schema.ts";
import { getFlowById } from "../services/user-flows.ts";
import { listFlows } from "../services/flow-service.ts";
import { listFlowVersions } from "../services/flow-versions.ts";
import { getFlowPackage } from "../services/flow-package.ts";
import { requireAdmin, requireFlow } from "../middleware/guards.ts";
import { createShareToken } from "../services/share-tokens.ts";

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

    // Fetch admin connections and resolve service statuses
    const adminConns = await getAdminConnections(flow.id);
    const serviceStatuses = await resolveServiceStatuses(m.requires.services, adminConns, user.id);

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

  // POST /api/flows/:id/services/:serviceId/bind — bind admin's connection to a service
  router.post("/:id/services/:serviceId/bind", requireFlow(), requireAdmin(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");
    const serviceId = c.req.param("serviceId");

    // Verify the service exists and is in admin mode
    const svc = flow.manifest.requires.services.find((s) => s.id === serviceId);
    if (!svc) {
      return c.json(
        { error: "SERVICE_NOT_FOUND", message: `Service '${serviceId}' introuvable` },
        404,
      );
    }
    if ((svc.connectionMode ?? "user") !== "admin") {
      return c.json(
        {
          error: "INVALID_CONNECTION_MODE",
          message: `Le service '${serviceId}' n'est pas en mode admin`,
        },
        400,
      );
    }

    // Verify admin has a connection for this provider
    const conn = await getConnectionStatus(svc.provider, user.id);
    if (conn.status !== "connected") {
      return c.json(
        {
          error: "ADMIN_NOT_CONNECTED",
          message: `Vous n'avez pas de connexion active pour '${svc.provider}'`,
        },
        400,
      );
    }

    await bindAdminConnection(flow.id, serviceId, user.id);
    return c.json({ bound: true });
  });

  // DELETE /api/flows/:id/services/:serviceId/bind — unbind admin's connection from a service
  router.delete("/:id/services/:serviceId/bind", requireFlow(), requireAdmin(), async (c) => {
    const flow = c.get("flow");
    const serviceId = c.req.param("serviceId");

    const svc = flow.manifest.requires.services.find((s) => s.id === serviceId);
    if (!svc) {
      return c.json(
        { error: "SERVICE_NOT_FOUND", message: `Service '${serviceId}' introuvable` },
        404,
      );
    }

    await unbindAdminConnection(flow.id, serviceId);
    return c.json({ unbound: true });
  });

  // POST /api/flows/:id/share-token — generate a one-time public share link (admin-only)
  router.post("/:id/share-token", requireFlow(), requireAdmin(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");
    const services = flow.manifest.requires.services;

    // Verify the flow is shareable publicly
    if (services.length > 0) {
      // Check for user-mode services
      const userModeService = services.find((s) => (s.connectionMode ?? "user") === "user");
      if (userModeService) {
        return c.json(
          {
            error: "SHARE_NOT_ALLOWED",
            message:
              "Ce flow ne peut pas etre partage publiquement car il necessite des connexions utilisateur.",
          },
          400,
        );
      }

      // All services are admin-mode — verify each is bound
      const adminConns = await getAdminConnections(flow.id);
      for (const svc of services) {
        if (!adminConns[svc.id]) {
          return c.json(
            {
              error: "SHARE_NOT_READY",
              message: "Tous les services admin doivent etre lies avant de generer un lien public.",
            },
            400,
          );
        }
      }
    }

    const shareToken = await createShareToken(flow.id, user.id);
    return c.json({
      token: shareToken.token,
      expiresAt: shareToken.expires_at,
    });
  });

  return router;
}
