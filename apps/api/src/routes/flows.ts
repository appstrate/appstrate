import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  getPackageConfig,
  setPackageConfig,
  getLastExecution,
  getRunningExecutionsCounts,
  getRunningExecutionsForPackage,
  getAdminConnections,
  bindAdminConnection,
  unbindAdminConnection,
  getPackageMemories,
  deletePackageMemory,
  deleteAllPackageMemories,
} from "../services/state.ts";
import { getConnectionStatus, resolveServiceStatuses } from "../services/connection-manager.ts";
import { validateConfig } from "../services/schema.ts";
import { getPackageById } from "../services/user-flows.ts";
import { listPackages } from "../services/flow-service.ts";
import { listPackageVersions } from "../services/package-versions.ts";
import { getPackageZip } from "../services/package-storage.ts";
import { computeIntegrity } from "@appstrate/core/integrity";
import { buildDownloadHeaders } from "@appstrate/core/download";
import { requireAdmin, requireFlow } from "../middleware/guards.ts";
import { createShareToken } from "../services/share-tokens.ts";
import {
  getEffectiveProfileId,
  setPackageProfileOverride,
  removePackageProfileOverride,
} from "../services/connection-profiles.ts";
import { parseScopedName } from "@appstrate/core/naming";

export function createFlowsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/flows — list all loaded flows
  router.get("/", async (c) => {
    const orgId = c.get("orgId");
    const [allFlows, runningCounts] = await Promise.all([
      listPackages(orgId),
      getRunningExecutionsCounts(orgId),
    ]);

    const flowList = allFlows.map((f) => {
      const parsed = parseScopedName(f.manifest.name);
      return {
        id: f.id,
        displayName: f.manifest.displayName,
        description: f.manifest.description,
        schemaVersion: f.manifest.schemaVersion,
        author: f.manifest.author,
        tags: f.manifest.tags ?? [],
        requires: {
          services: f.manifest.requires.services.map((s) => s.id),
          skills: f.skills.map((s) => s.id),
          extensions: f.extensions.map((e) => e.id),
        },
        runningExecutions: runningCounts[f.id] ?? 0,
        source: f.source,
        scope: parsed?.scope ?? null,
        version: f.manifest.version ?? null,
        type: f.manifest.type ?? "flow",
      };
    });

    return c.json({ flows: flowList });
  });

  // GET /api/flows/:scope/:name — flow detail with dependency status
  router.get("/:scope{@[^/]+}/:name", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");
    const orgId = c.get("orgId");
    const m = flow.manifest;

    // Fetch admin connections and user's effective profile
    const queryProfileId = c.req.query("profileId");
    const [adminConns, userProfileId] = await Promise.all([
      getAdminConnections(orgId, flow.id),
      queryProfileId ? Promise.resolve(queryProfileId) : getEffectiveProfileId(user.id, flow.id),
    ]);

    const serviceStatuses = await resolveServiceStatuses(
      m.requires.services,
      adminConns,
      orgId,
      userProfileId,
    );

    // Get config (global), last execution (per-user), running count (per-user)
    // For user flows, also fetch the raw DB row for editable content
    const [currentConfig, lastExec, runningCount, userFlowRow] = await Promise.all([
      getPackageConfig(orgId, flow.id),
      getLastExecution(flow.id, user.id, orgId),
      getRunningExecutionsForPackage(flow.id, user.id),
      flow.source !== "built-in" ? getPackageById(flow.id) : Promise.resolve(null),
    ]);

    // Merge defaults with current config
    const configWithDefaults: Record<string, unknown> = {};
    if (m.config?.schema?.properties) {
      for (const [key, prop] of Object.entries(m.config.schema.properties)) {
        configWithDefaults[key] = currentConfig[key] ?? prop.default ?? null;
      }
    }

    const detailParsed = parseScopedName(m.name);

    return c.json({
      id: flow.id,
      displayName: m.displayName,
      description: m.description,
      source: flow.source,
      scope: detailParsed?.scope ?? null,
      version: m.version ?? null,
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
      runningExecutions: runningCount,
      lastExecution: lastExec
        ? {
            id: lastExec.id,
            status: lastExec.status,
            startedAt: lastExec.startedAt,
            duration: lastExec.duration,
          }
        : null,
      ...(flow.source !== "built-in" && userFlowRow
        ? {
            manifest: flow.manifest,
            updatedAt: userFlowRow.updatedAt,
            lockVersion: userFlowRow.version,
            prompt: flow.prompt,
            lastPublishedVersion: userFlowRow.lastPublishedVersion ?? null,
            lastPublishedAt: userFlowRow.lastPublishedAt ?? null,
          }
        : {}),
    });
  });

  // PUT /api/flows/:scope/:name/config — save flow configuration (admin-only)
  router.put("/:scope{@[^/]+}/:name/config", requireFlow(), requireAdmin(), async (c) => {
    const flow = c.get("flow");

    const body = await c.req.json<Record<string, unknown>>();
    const schema = flow.manifest.config?.schema ?? { type: "object" as const, properties: {} };

    // Validate config with AJV
    const validation = validateConfig(body, schema);
    if (!validation.valid) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "Invalid configuration",
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

    const orgId = c.get("orgId");
    await setPackageConfig(orgId, flow.id, config);

    return c.json({
      config,
      validation: { valid: true },
    });
  });

  // GET /api/flows/:scope/:name/package — download the flow ZIP
  router.get("/:scope{@[^/]+}/:name/package", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const orgId = c.get("orgId");

    const zipBuffer = await getPackageZip(flow, orgId);
    if (!zipBuffer) {
      return c.json({ error: "FLOW_NOT_FOUND", message: "Package not found" }, 404);
    }

    const integrity = computeIntegrity(new Uint8Array(zipBuffer));
    const version = (flow.manifest.version as string) ?? "0.0.0";
    const downloadHeaders = buildDownloadHeaders({
      integrity,
      yanked: false,
      scope: c.req.param("scope"),
      name: c.req.param("name"),
      version,
    });
    return new Response(new Uint8Array(zipBuffer), { status: 200, headers: downloadHeaders });
  });

  // GET /api/flows/:scope/:name/versions — list flow version history (user flows only)
  router.get("/:scope{@[^/]+}/:name/versions", requireFlow(), async (c) => {
    const flow = c.get("flow");

    if (flow.source === "built-in") {
      return c.json(
        { error: "OPERATION_NOT_ALLOWED", message: "Built-in flows do not have version history" },
        400,
      );
    }

    const versions = await listPackageVersions(flow.id);
    return c.json({ versions });
  });

  // POST /api/flows/:scope/:name/services/:serviceId/bind — bind a profile's connection to a service
  router.post(
    "/:scope{@[^/]+}/:name/services/:serviceId/bind",
    requireFlow(),
    requireAdmin(),
    async (c) => {
      const flow = c.get("flow");
      const user = c.get("user");
      const serviceId = c.req.param("serviceId");

      // Verify the service exists and is in admin mode
      const svc = flow.manifest.requires.services.find((s) => s.id === serviceId);
      if (!svc) {
        return c.json(
          { error: "SERVICE_NOT_FOUND", message: `Service '${serviceId}' not found` },
          404,
        );
      }
      if ((svc.connectionMode ?? "user") !== "admin") {
        return c.json(
          {
            error: "INVALID_CONNECTION_MODE",
            message: `Service '${serviceId}' is not in admin mode`,
          },
          400,
        );
      }

      // Get profile from body or default
      let profileId: string | undefined;
      try {
        const body = await c.req.json<{ profileId?: string }>();
        profileId = body.profileId;
      } catch {
        // No body — use default profile
      }
      const effectiveProfileId = profileId ?? (await getEffectiveProfileId(user.id));

      // Verify the profile has a connection for this provider
      const orgId = c.get("orgId");
      const conn = await getConnectionStatus(svc.provider, effectiveProfileId, orgId);
      if (conn.status !== "connected") {
        return c.json(
          {
            error: "ADMIN_NOT_CONNECTED",
            message: `No active connection for '${svc.provider}'`,
          },
          400,
        );
      }

      await bindAdminConnection(orgId, flow.id, serviceId, effectiveProfileId);
      return c.json({ bound: true });
    },
  );

  // DELETE /api/flows/:scope/:name/services/:serviceId/bind — unbind admin's connection from a service
  router.delete(
    "/:scope{@[^/]+}/:name/services/:serviceId/bind",
    requireFlow(),
    requireAdmin(),
    async (c) => {
      const flow = c.get("flow");
      const serviceId = c.req.param("serviceId");

      const svc = flow.manifest.requires.services.find((s) => s.id === serviceId);
      if (!svc) {
        return c.json(
          { error: "SERVICE_NOT_FOUND", message: `Service '${serviceId}' not found` },
          404,
        );
      }

      await unbindAdminConnection(c.get("orgId"), flow.id, serviceId);
      return c.json({ unbound: true });
    },
  );

  // PUT /api/flows/:scope/:name/profile — set flow profile override
  router.put("/:scope{@[^/]+}/:name/profile", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");
    const body = await c.req.json<{ profileId: string }>();
    if (!body.profileId) {
      return c.json({ error: "VALIDATION_ERROR", message: "profileId is required" }, 400);
    }
    await setPackageProfileOverride(user.id, flow.id, body.profileId);
    return c.json({ success: true });
  });

  // DELETE /api/flows/:scope/:name/profile — remove flow profile override
  router.delete("/:scope{@[^/]+}/:name/profile", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");
    await removePackageProfileOverride(user.id, flow.id);
    return c.json({ success: true });
  });

  // GET /api/flows/:scope/:name/proxy — get flow proxy configuration
  router.get("/:scope{@[^/]+}/:name/proxy", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const orgId = c.get("orgId");
    const config = await getPackageConfig(orgId, flow.id);
    const proxyId = (config.__proxyId as string | null) ?? null;

    return c.json({ proxyId, resolved: proxyId !== "none" });
  });

  // PUT /api/flows/:scope/:name/proxy — set flow proxy override (admin-only)
  router.put("/:scope{@[^/]+}/:name/proxy", requireFlow(), requireAdmin(), async (c) => {
    const flow = c.get("flow");
    const orgId = c.get("orgId");
    const body = await c.req.json<{ proxyId: string | null }>();

    // Read existing config and merge __proxyId
    const currentConfig = await getPackageConfig(orgId, flow.id);
    if (body.proxyId === null) {
      // Remove the override
      const { __proxyId: _, ...rest } = currentConfig;
      await setPackageConfig(orgId, flow.id, rest);
    } else {
      await setPackageConfig(orgId, flow.id, { ...currentConfig, __proxyId: body.proxyId });
    }

    return c.json({ success: true });
  });

  // GET /api/flows/:scope/:name/memories — list flow memories
  router.get("/:scope{@[^/]+}/:name/memories", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const orgId = c.get("orgId");
    const memories = await getPackageMemories(flow.id, orgId);
    return c.json({
      memories: memories.map((m) => ({
        id: m.id,
        content: m.content,
        executionId: m.executionId,
        createdAt: m.createdAt?.toISOString() ?? null,
      })),
    });
  });

  // DELETE /api/flows/:scope/:name/memories — delete all memories (admin only)
  router.delete("/:scope{@[^/]+}/:name/memories", requireFlow(), requireAdmin(), async (c) => {
    const flow = c.get("flow");
    const orgId = c.get("orgId");
    const deleted = await deleteAllPackageMemories(flow.id, orgId);
    return c.json({ deleted });
  });

  // DELETE /api/flows/:scope/:name/memories/:memoryId — delete single memory (admin only)
  router.delete(
    "/:scope{@[^/]+}/:name/memories/:memoryId",
    requireFlow(),
    requireAdmin(),
    async (c) => {
      const flow = c.get("flow");
      const orgId = c.get("orgId");
      const memoryId = parseInt(c.req.param("memoryId"), 10);
      if (isNaN(memoryId)) {
        return c.json({ error: "VALIDATION_ERROR", message: "Invalid memory ID" }, 400);
      }
      const deleted = await deletePackageMemory(memoryId, flow.id, orgId);
      if (!deleted) {
        return c.json({ error: "NOT_FOUND", message: "Memory not found" }, 404);
      }
      return c.json({ deleted: true });
    },
  );

  // POST /api/flows/:scope/:name/share-token — generate a one-time public share link (admin-only)
  router.post("/:scope{@[^/]+}/:name/share-token", requireFlow(), requireAdmin(), async (c) => {
    const flow = c.get("flow");
    const user = c.get("user");
    const orgId = c.get("orgId");
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
              "This flow cannot be shared publicly because it requires user-mode connections.",
          },
          400,
        );
      }

      // All services are admin-mode — verify each is bound
      const adminConns = await getAdminConnections(orgId, flow.id);
      for (const svc of services) {
        if (!adminConns[svc.id]) {
          return c.json(
            {
              error: "SHARE_NOT_READY",
              message: "All admin services must be bound before generating a public link.",
            },
            400,
          );
        }
      }
    }

    const shareToken = await createShareToken(flow.id, user.id, orgId);
    if (!shareToken) throw new Error("Failed to create share token");
    return c.json({
      token: shareToken.token,
      expiresAt: shareToken.expiresAt,
    });
  });

  return router;
}
