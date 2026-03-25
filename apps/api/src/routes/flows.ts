import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  setPackageConfig,
  getPackageConfigFull,
  setFlowOverride,
  getRunningExecutionsCounts,
  bindFlowProvider,
  unbindFlowProvider,
  getPackageMemories,
  deletePackageMemory,
  deleteAllPackageMemories,
} from "../services/state/index.ts";
import { getConnectionStatus } from "../services/connection-manager/index.ts";
import { validateConfig } from "../services/schema.ts";
import { listPackages } from "../services/flow-service.ts";
import { requireAdmin, requireFlow } from "../middleware/guards.ts";
import { getActor } from "../lib/actor.ts";
import {
  getEffectiveProfileId,
  setPackageProfileOverride,
  removePackageProfileOverride,
} from "../services/connection-profiles.ts";
import { parseScopedName } from "@appstrate/core/naming";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { z } from "zod";
import { invalidRequest, notFound, parseBody } from "../lib/errors.ts";

const proxyIdSchema = z.object({ proxyId: z.string().nullable() });
const modelIdSchema = z.object({ modelId: z.string().nullable() });

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
        keywords: f.manifest.keywords ?? [],
        dependencies: {
          providers: resolveManifestProviders(f.manifest).map((s) => s.id),
          skills: Object.fromEntries(f.skills.map((s) => [s.id, s.version ?? "*"])),
          tools: Object.fromEntries(f.tools.map((e) => [e.id, e.version ?? "*"])),
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

  // PUT /api/flows/:scope/:name/config — save flow configuration (admin-only)
  router.put("/:scope{@[^/]+}/:name/config", requireFlow(), requireAdmin(), async (c) => {
    const flow = c.get("flow");

    const body = await c.req.json<Record<string, unknown>>();
    const schema = flow.manifest.config?.schema ?? { type: "object" as const, properties: {} };

    // Validate config with AJV
    const validation = validateConfig(body, schema);
    if (!validation.valid) {
      throw invalidRequest("Invalid configuration");
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

  // POST /api/flows/:scope/:name/providers/:providerScope/:providerName/bind — bind a profile's connection to a provider
  router.post(
    "/:scope{@[^/]+}/:name/providers/:providerScope{@[^/]+}/:providerName/bind",
    requireFlow(),
    requireAdmin(),
    async (c) => {
      const flow = c.get("flow");
      const actor = getActor(c);
      const providerId = `${c.req.param("providerScope")}/${c.req.param("providerName")}`;

      // Verify the provider exists and is in admin mode
      const provider = resolveManifestProviders(flow.manifest).find((s) => s.id === providerId);
      if (!provider) {
        throw notFound(`Provider '${providerId}' not found`);
      }
      if ((provider.connectionMode ?? "user") !== "admin") {
        throw invalidRequest(`Provider '${providerId}' is not in admin mode`);
      }

      // Get profile from body or default
      let profileId: string | undefined;
      try {
        const body = await c.req.json<{ profileId?: string }>();
        profileId = body.profileId;
      } catch {
        // No body — use default profile
      }
      const effectiveProfileId = profileId ?? (await getEffectiveProfileId(actor));

      // Verify the profile has a connection for this provider
      const orgId = c.get("orgId");
      const conn = await getConnectionStatus(provider.id, effectiveProfileId, orgId);
      if (conn.status !== "connected") {
        throw invalidRequest(`No active connection for '${provider.id}'`);
      }

      await bindFlowProvider(orgId, flow.id, providerId, effectiveProfileId);
      return c.json({ bound: true });
    },
  );

  // DELETE /api/flows/:scope/:name/providers/:providerScope/:providerName/bind — unbind admin's connection from a provider
  router.delete(
    "/:scope{@[^/]+}/:name/providers/:providerScope{@[^/]+}/:providerName/bind",
    requireFlow(),
    requireAdmin(),
    async (c) => {
      const flow = c.get("flow");
      const providerId = `${c.req.param("providerScope")}/${c.req.param("providerName")}`;

      const provider = resolveManifestProviders(flow.manifest).find((s) => s.id === providerId);
      if (!provider) {
        throw notFound(`Provider '${providerId}' not found`);
      }

      await unbindFlowProvider(c.get("orgId"), flow.id, providerId);
      return c.json({ unbound: true });
    },
  );

  // PUT /api/flows/:scope/:name/profile — set flow profile override
  router.put("/:scope{@[^/]+}/:name/profile", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const actor = getActor(c);
    const body = await c.req.json();
    const data = parseBody(
      z.object({ profileId: z.string().min(1, "profileId is required") }),
      body,
      "profileId",
    );
    await setPackageProfileOverride(actor, flow.id, data.profileId);
    return c.json({ success: true });
  });

  // DELETE /api/flows/:scope/:name/profile — remove flow profile override
  router.delete("/:scope{@[^/]+}/:name/profile", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const actor = getActor(c);
    await removePackageProfileOverride(actor, flow.id);
    return c.json({ success: true });
  });

  // GET /api/flows/:scope/:name/proxy — get flow proxy configuration
  router.get("/:scope{@[^/]+}/:name/proxy", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const orgId = c.get("orgId");
    const { proxyId } = await getPackageConfigFull(orgId, flow.id);

    return c.json({ proxyId, resolved: proxyId !== "none" });
  });

  // PUT /api/flows/:scope/:name/proxy — set flow proxy override (admin-only)
  router.put("/:scope{@[^/]+}/:name/proxy", requireFlow(), requireAdmin(), async (c) => {
    const flow = c.get("flow");
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const data = parseBody(proxyIdSchema, body);

    await setFlowOverride(orgId, flow.id, "proxyId", data.proxyId);

    return c.json({ success: true });
  });

  // GET /api/flows/:scope/:name/model — get flow model configuration
  router.get("/:scope{@[^/]+}/:name/model", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const orgId = c.get("orgId");
    const { modelId } = await getPackageConfigFull(orgId, flow.id);

    return c.json({ modelId });
  });

  // PUT /api/flows/:scope/:name/model — set flow model override (admin-only)
  router.put("/:scope{@[^/]+}/:name/model", requireFlow(), requireAdmin(), async (c) => {
    const flow = c.get("flow");
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const data = parseBody(modelIdSchema, body);

    await setFlowOverride(orgId, flow.id, "modelId", data.modelId);

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
      const result = z.coerce.number().int().min(1).safeParse(c.req.param("memoryId"));
      if (!result.success) {
        throw invalidRequest("Invalid memory ID", "memoryId");
      }
      const memoryId = result.data;
      const deleted = await deletePackageMemory(memoryId, flow.id, orgId);
      if (!deleted) {
        throw notFound("Memory not found");
      }
      return c.json({ deleted: true });
    },
  );

  return router;
}
