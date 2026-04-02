// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  setPackageConfig,
  getPackageConfig,
  setAgentOverride,
  getRunningRunCounts,
  getPackageMemories,
  deletePackageMemory,
  deleteAllPackageMemories,
} from "../services/state/index.ts";
import { validateConfig } from "../services/schema.ts";
import { listPackages } from "../services/agent-service.ts";
import { requireAgent } from "../middleware/guards.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getActor } from "../lib/actor.ts";
import {
  setUserAgentProviderOverride,
  removeUserAgentProviderOverride,
  getUserAgentProviderOverrides,
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

export function createAgentsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/agents — list all loaded agents
  router.get("/", async (c) => {
    const orgId = c.get("orgId");
    const [allAgents, runningCounts] = await Promise.all([
      listPackages(orgId),
      getRunningRunCounts(orgId),
    ]);

    const agentList = allAgents.map((f) => {
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
        runningRuns: runningCounts[f.id] ?? 0,
        source: f.source,
        scope: parsed?.scope ?? null,
        version: f.manifest.version,
        type: f.manifest.type,
      };
    });

    return c.json({ agents: agentList });
  });

  // PUT /api/agents/:scope/:name/config — save agent configuration (admin-only)
  router.put(
    "/:scope{@[^/]+}/:name/config",
    requireAgent(),
    requirePermission("agents", "configure"),
    async (c) => {
      const agent = c.get("agent");

      const body = await c.req.json<Record<string, unknown>>();
      const schema = agent.manifest.config?.schema ?? { type: "object" as const, properties: {} };

      // Validate config with AJV
      const validation = validateConfig(body, asJSONSchemaObject(schema));
      if (!validation.valid) {
        throw invalidRequest("Invalid configuration");
      }

      const config = mergeWithDefaults(asJSONSchemaObject(schema), body);

      const orgId = c.get("orgId");
      await setPackageConfig(orgId, agent.id, config);

      return c.json({
        config,
        validation: { valid: true },
      });
    },
  );

  // GET /api/agents/:scope/:name/provider-profiles — get per-provider profile overrides
  router.get("/:scope{@[^/]+}/:name/provider-profiles", requireAgent(), async (c) => {
    const agent = c.get("agent");
    const actor = getActor(c);
    const overrides = await getUserAgentProviderOverrides(actor, agent.id);
    return c.json({ overrides });
  });

  // PUT /api/agents/:scope/:name/provider-profiles — set per-provider override
  // Provider ID passed in body (scoped IDs contain slashes, can't be in URL)
  router.put(
    "/:scope{@[^/]+}/:name/provider-profiles",
    requireAgent(),
    requirePermission("agents", "run"),
    async (c) => {
      const agent = c.get("agent");
      const actor = getActor(c);
      const body = await c.req.json();
      const data = parseBody(
        z.object({ providerId: z.string().min(1), profileId: z.uuid() }),
        body,
      );

      // Validate ownership — user can only set overrides to their own profiles
      const profile = await getAccessibleProfile(data.profileId, actor, c.get("orgId"));
      if (!profile) {
        throw forbidden("Cannot use a profile you do not own");
      }

      await setUserAgentProviderOverride(actor, agent.id, data.providerId, data.profileId);
      return c.json({ success: true });
    },
  );

  // DELETE /api/agents/:scope/:name/provider-profiles — remove per-provider override
  // Provider ID passed in body
  router.delete(
    "/:scope{@[^/]+}/:name/provider-profiles",
    requireAgent(),
    requirePermission("agents", "run"),
    async (c) => {
      const agent = c.get("agent");
      const actor = getActor(c);
      const body = await c.req.json();
      const data = parseBody(z.object({ providerId: z.string().min(1) }), body);
      await removeUserAgentProviderOverride(actor, agent.id, data.providerId);
      return c.json({ success: true });
    },
  );

  // GET /api/agents/:scope/:name/proxy — get agent proxy configuration
  router.get("/:scope{@[^/]+}/:name/proxy", requireAgent(), async (c) => {
    const agent = c.get("agent");
    const orgId = c.get("orgId");
    const { proxyId } = await getPackageConfig(orgId, agent.id);

    return c.json({ proxyId, resolved: proxyId !== "none" });
  });

  // PUT /api/agents/:scope/:name/proxy — set agent proxy override (admin-only)
  router.put(
    "/:scope{@[^/]+}/:name/proxy",
    requireAgent(),
    requirePermission("agents", "configure"),
    async (c) => {
      const agent = c.get("agent");
      const orgId = c.get("orgId");
      const body = await c.req.json();
      const data = parseBody(proxyIdSchema, body);

      await setAgentOverride(orgId, agent.id, "proxyId", data.proxyId);

      return c.json({ success: true });
    },
  );

  // GET /api/agents/:scope/:name/model — get agent model configuration
  router.get("/:scope{@[^/]+}/:name/model", requireAgent(), async (c) => {
    const agent = c.get("agent");
    const orgId = c.get("orgId");
    const { modelId } = await getPackageConfig(orgId, agent.id);

    return c.json({ modelId });
  });

  // PUT /api/agents/:scope/:name/model — set agent model override (admin-only)
  router.put(
    "/:scope{@[^/]+}/:name/model",
    requireAgent(),
    requirePermission("agents", "configure"),
    async (c) => {
      const agent = c.get("agent");
      const orgId = c.get("orgId");
      const body = await c.req.json();
      const data = parseBody(modelIdSchema, body);

      await setAgentOverride(orgId, agent.id, "modelId", data.modelId);

      return c.json({ success: true });
    },
  );

  // PUT /api/agents/:scope/:name/org-profile — set org profile for this agent (admin-only)
  router.put(
    "/:scope{@[^/]+}/:name/org-profile",
    requireAgent(),
    requirePermission("agents", "configure"),
    async (c) => {
      const agent = c.get("agent");
      const orgId = c.get("orgId");
      const body = await c.req.json();
      const data = parseBody(orgProfileIdSchema, body);

      await setAgentOverride(orgId, agent.id, "orgProfileId", data.orgProfileId);

      return c.json({ success: true });
    },
  );

  // GET /api/agents/:scope/:name/memories — list agent memories
  router.get("/:scope{@[^/]+}/:name/memories", requireAgent(), async (c) => {
    const agent = c.get("agent");
    const orgId = c.get("orgId");
    const memories = await getPackageMemories(agent.id, orgId);
    return c.json({
      memories: memories.map((m) => ({
        id: m.id,
        content: m.content,
        runId: m.runId,
        createdAt: m.createdAt?.toISOString() ?? null,
      })),
    });
  });

  // DELETE /api/agents/:scope/:name/memories — delete all memories (admin only)
  router.delete(
    "/:scope{@[^/]+}/:name/memories",
    requireAgent(),
    requirePermission("memories", "delete"),
    async (c) => {
      const agent = c.get("agent");
      const orgId = c.get("orgId");
      const deleted = await deleteAllPackageMemories(agent.id, orgId);
      return c.json({ deleted });
    },
  );

  // DELETE /api/agents/:scope/:name/memories/:memoryId — delete single memory (admin only)
  router.delete(
    "/:scope{@[^/]+}/:name/memories/:memoryId",
    requireAgent(),
    requirePermission("memories", "delete"),
    async (c) => {
      const agent = c.get("agent");
      const orgId = c.get("orgId");
      const result = z.coerce.number().int().min(1).safeParse(c.req.param("memoryId"));
      if (!result.success) {
        throw invalidRequest("Invalid memory ID", "memoryId");
      }
      const memoryId = result.data;
      const deleted = await deletePackageMemory(memoryId, agent.id, orgId);
      if (!deleted) {
        throw notFound("Memory not found");
      }
      return c.json({ deleted: true });
    },
  );

  return router;
}
