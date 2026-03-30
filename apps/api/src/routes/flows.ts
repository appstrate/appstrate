import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  setPackageConfig,
  getPackageConfig,
  setFlowOverride,
  getRunningExecutionsCounts,
  getPackageMemories,
  deletePackageMemory,
  deleteAllPackageMemories,
} from "../services/state/index.ts";
import { validateConfig } from "../services/schema.ts";
import { listPackages } from "../services/flow-service.ts";
import { requireAdmin, requireFlow } from "../middleware/guards.ts";
import { getActor } from "../lib/actor.ts";
import {
  setUserFlowProviderOverride,
  removeUserFlowProviderOverride,
  getUserFlowProviderOverrides,
  getAccessibleProfile,
} from "../services/connection-profiles.ts";
import { parseScopedName } from "@appstrate/core/naming";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { z } from "zod";
import { forbidden, invalidRequest, notFound, parseBody } from "../lib/errors.ts";
import { asJSONSchemaObject, mergeWithDefaults } from "@appstrate/core/form";

const proxyIdSchema = z.object({ proxyId: z.string().nullable() });
const modelIdSchema = z.object({ modelId: z.string().nullable() });
const orgProfileIdSchema = z.object({ orgProfileId: z.uuid().nullable() });

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
        version: f.manifest.version,
        type: f.manifest.type,
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
    const validation = validateConfig(body, asJSONSchemaObject(schema));
    if (!validation.valid) {
      throw invalidRequest("Invalid configuration");
    }

    const config = mergeWithDefaults(asJSONSchemaObject(schema), body);

    const orgId = c.get("orgId");
    await setPackageConfig(orgId, flow.id, config);

    return c.json({
      config,
      validation: { valid: true },
    });
  });

  // GET /api/flows/:scope/:name/provider-profiles — get per-provider profile overrides
  router.get("/:scope{@[^/]+}/:name/provider-profiles", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const actor = getActor(c);
    const overrides = await getUserFlowProviderOverrides(actor, flow.id);
    return c.json({ overrides });
  });

  // PUT /api/flows/:scope/:name/provider-profiles — set per-provider override
  // Provider ID passed in body (scoped IDs contain slashes, can't be in URL)
  router.put("/:scope{@[^/]+}/:name/provider-profiles", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const actor = getActor(c);
    const body = await c.req.json();
    const data = parseBody(z.object({ providerId: z.string().min(1), profileId: z.uuid() }), body);

    // Validate ownership — user can only set overrides to their own profiles
    const profile = await getAccessibleProfile(data.profileId, actor, c.get("orgId"));
    if (!profile) {
      throw forbidden("Cannot use a profile you do not own");
    }

    await setUserFlowProviderOverride(actor, flow.id, data.providerId, data.profileId);
    return c.json({ success: true });
  });

  // DELETE /api/flows/:scope/:name/provider-profiles — remove per-provider override
  // Provider ID passed in body
  router.delete("/:scope{@[^/]+}/:name/provider-profiles", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const actor = getActor(c);
    const body = await c.req.json();
    const data = parseBody(z.object({ providerId: z.string().min(1) }), body);
    await removeUserFlowProviderOverride(actor, flow.id, data.providerId);
    return c.json({ success: true });
  });

  // GET /api/flows/:scope/:name/proxy — get flow proxy configuration
  router.get("/:scope{@[^/]+}/:name/proxy", requireFlow(), async (c) => {
    const flow = c.get("flow");
    const orgId = c.get("orgId");
    const { proxyId } = await getPackageConfig(orgId, flow.id);

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
    const { modelId } = await getPackageConfig(orgId, flow.id);

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

  // PUT /api/flows/:scope/:name/org-profile — set org profile for this flow (admin-only)
  router.put("/:scope{@[^/]+}/:name/org-profile", requireFlow(), requireAdmin(), async (c) => {
    const flow = c.get("flow");
    const orgId = c.get("orgId");
    const body = await c.req.json();
    const data = parseBody(orgProfileIdSchema, body);

    await setFlowOverride(orgId, flow.id, "orgProfileId", data.orgProfileId);

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
