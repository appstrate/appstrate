// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  getRunningRunCounts,
  getPackageMemories,
  deletePackageMemory,
  deleteAllPackageMemories,
} from "../services/state/index.ts";
import { validateConfig } from "../services/schema.ts";
import {
  listAccessiblePackages,
  updateInstalledPackage,
  getPackageConfig,
} from "../services/application-packages.ts";
import { asRecord } from "../lib/safe-json.ts";
import type { AgentManifest } from "../types/index.ts";
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
import { z } from "zod";
import { forbidden, invalidRequest, notFound, parseBody } from "../lib/errors.ts";
import { asJSONSchemaObject, mergeWithDefaults } from "@appstrate/core/form";
import { getAppScope } from "../lib/scope.ts";
import { buildBundleForAgentExport } from "../services/bundle-assembly.ts";
import { writeBundleToBuffer } from "@appstrate/afps-runtime/bundle";
import { rateLimit } from "../middleware/rate-limit.ts";
export const proxyIdSchema = z.object({ proxyId: z.string().nullable() });
export const modelIdSchema = z.object({ modelId: z.string().nullable() });
export const appProfileIdSchema = z.object({ appProfileId: z.uuid().nullable() });
export const setProviderProfileSchema = z.object({
  providerId: z.string().min(1),
  profileId: z.uuid(),
});
export const removeProviderProfileSchema = z.object({ providerId: z.string().min(1) });

export function createAgentsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/agents — list agents accessible to the current application
  router.get("/", async (c) => {
    const scope = getAppScope(c);

    // Single query: system packages + installed packages via LEFT JOIN
    const [rows, runningCounts] = await Promise.all([
      listAccessiblePackages(scope, "agent"),
      getRunningRunCounts(scope),
    ]);

    const agentList = rows.map((row) => {
      const manifest = asRecord(row.draftManifest) as AgentManifest;
      const parsed = parseScopedName(manifest.name);
      return {
        id: row.id,
        displayName: manifest.displayName,
        description: manifest.description,
        schemaVersion: manifest.schemaVersion,
        author: manifest.author,
        keywords: manifest.keywords ?? [],
        dependencies: {
          providers: (manifest.dependencies?.providers ?? {}) as Record<string, string>,
          skills: (manifest.dependencies?.skills ?? {}) as Record<string, string>,
          tools: (manifest.dependencies?.tools ?? {}) as Record<string, string>,
        },
        runningRuns: runningCounts[row.id] ?? 0,
        source: row.source ?? "local",
        scope: parsed?.scope ?? null,
        version: manifest.version,
        type: manifest.type,
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

      const scope = getAppScope(c);
      await updateInstalledPackage(scope, agent.id, { config });

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
      const data = parseBody(setProviderProfileSchema, body);

      // Validate ownership — user can only set overrides to their own profiles
      const profile = await getAccessibleProfile(data.profileId, actor, {
        orgId: c.get("orgId"),
        applicationId: c.get("applicationId")!,
      });
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
      const data = parseBody(removeProviderProfileSchema, body);
      await removeUserAgentProviderOverride(actor, agent.id, data.providerId);
      return c.json({ success: true });
    },
  );

  // GET /api/agents/:scope/:name/proxy — get agent proxy configuration
  router.get("/:scope{@[^/]+}/:name/proxy", requireAgent(), async (c) => {
    const agent = c.get("agent");
    const applicationId = c.get("applicationId");
    const { proxyId } = await getPackageConfig(applicationId, agent.id);

    return c.json({ proxyId, resolved: proxyId !== "none" });
  });

  // PUT /api/agents/:scope/:name/proxy — set agent proxy override (admin-only)
  router.put(
    "/:scope{@[^/]+}/:name/proxy",
    requireAgent(),
    requirePermission("agents", "configure"),
    async (c) => {
      const agent = c.get("agent");
      const scope = getAppScope(c);
      const body = await c.req.json();
      const data = parseBody(proxyIdSchema, body);

      await updateInstalledPackage(scope, agent.id, { proxyId: data.proxyId });

      return c.json({ success: true });
    },
  );

  // GET /api/agents/:scope/:name/model — get agent model configuration
  router.get("/:scope{@[^/]+}/:name/model", requireAgent(), async (c) => {
    const agent = c.get("agent");
    const applicationId = c.get("applicationId");
    const { modelId } = await getPackageConfig(applicationId, agent.id);

    return c.json({ modelId });
  });

  // PUT /api/agents/:scope/:name/model — set agent model override (admin-only)
  router.put(
    "/:scope{@[^/]+}/:name/model",
    requireAgent(),
    requirePermission("agents", "configure"),
    async (c) => {
      const agent = c.get("agent");
      const scope = getAppScope(c);
      const body = await c.req.json();
      const data = parseBody(modelIdSchema, body);

      await updateInstalledPackage(scope, agent.id, { modelId: data.modelId });

      return c.json({ success: true });
    },
  );

  // PUT /api/agents/:scope/:name/app-profile — set app profile for this agent (admin-only)
  router.put(
    "/:scope{@[^/]+}/:name/app-profile",
    requireAgent(),
    requirePermission("agents", "configure"),
    async (c) => {
      const agent = c.get("agent");
      const scope = getAppScope(c);
      const body = await c.req.json();
      const data = parseBody(appProfileIdSchema, body);

      await updateInstalledPackage(scope, agent.id, { appProfileId: data.appProfileId });

      return c.json({ success: true });
    },
  );

  // GET /api/agents/:scope/:name/memories — list agent memories
  router.get("/:scope{@[^/]+}/:name/memories", requireAgent(), async (c) => {
    const agent = c.get("agent");
    const applicationId = c.get("applicationId");
    const memories = await getPackageMemories(agent.id, applicationId);
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
      const applicationId = c.get("applicationId");
      const deleted = await deleteAllPackageMemories(agent.id, applicationId);
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
      const applicationId = c.get("applicationId");
      const result = z.coerce.number().int().min(1).safeParse(c.req.param("memoryId"));
      if (!result.success) {
        throw invalidRequest("Invalid memory ID", "memoryId");
      }
      const memoryId = result.data;
      const deleted = await deletePackageMemory(memoryId, agent.id, applicationId);
      if (!deleted) {
        throw notFound("Memory not found");
      }
      return c.json({ deleted: true });
    },
  );

  // GET /api/agents/:scope/:name/bundle — export the agent as an .afps-bundle
  // (multi-package archive with pinned versions of every transitive dep).
  router.get(
    "/:scope{@[^/]+}/:name/bundle",
    rateLimit(30),
    requireAgent(),
    requirePermission("agents", "read"),
    async (c) => {
      const agent = c.get("agent");
      const scope = getAppScope(c);
      const versionQuery = c.req.query("version") ?? null;

      // Omit time-varying metadata (createdAt) so two exports of the same
      // (package, version) produce byte-identical archives — this makes
      // the export cache-friendly and the determinism contract explicit.
      const bundle = await buildBundleForAgentExport(agent.id, scope, {
        versionQuery,
        metadata: { builder: "appstrate-platform" },
      });

      const bytes = writeBundleToBuffer(bundle);
      const parsed = parseScopedName(agent.id);
      const safeName = parsed ? `${parsed.scope}-${parsed.name}` : "bundle";

      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          // Standard `application/zip` so generic ZIP tooling, browser
          // download flows, and proxy/CDN content sniffing all work without
          // special-casing. The vendor type added no compatibility benefit
          // and broke streaming clients that match on MIME.
          "Content-Type": "application/zip",
          "Content-Length": String(bytes.byteLength),
          // Filename uses `.zip` so OS file managers (which dispatch by
          // extension, not MIME) hand the file off to the system archive
          // tool. The double extension `.afps-bundle.zip` keeps the AFPS
          // bundle marker in the filename for users who care, while
          // staying portable. RFC 6266 escaping: `safeName` is built
          // from the scoped agent id which is `[a-z0-9-/_]` only, so
          // no quoting hazard here.
          "Content-Disposition": `attachment; filename="${safeName}.afps-bundle.zip"`,
          "X-Bundle-Integrity": bundle.integrity,
        },
      });
    },
  );

  return router;
}
