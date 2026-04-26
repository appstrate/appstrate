// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  getRunningRunCounts,
  listPinnedSlots,
  listMemories,
  deleteMemory,
  deleteAllMemories,
  deleteCheckpoint,
  deletePinnedSlotById,
  scopeFromActor,
  type PersistenceScope,
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

/**
 * Parse the `actorType` / `actorId` query-param pair shared by the
 * persistence GET / DELETE routes into a {@link PersistenceScope}.
 * Returns `null` when the caller did not supply `actorType` (i.e. no
 * scope override) and throws `invalidRequest` when the combination is
 * malformed.
 */
function scopeFromQueryParams(
  actorTypeParam: string | undefined,
  actorIdParam: string | undefined,
): PersistenceScope | null {
  if (!actorTypeParam) return null;
  if (actorTypeParam === "shared") return { type: "shared" };
  if (actorTypeParam === "user" && actorIdParam) {
    return { type: "member", id: actorIdParam };
  }
  if (actorTypeParam === "end_user" && actorIdParam) {
    return { type: "end_user", id: actorIdParam };
  }
  throw invalidRequest("Invalid actorType / actorId combination");
}

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

  // ─────────────────────────────────────────────────────────────────
  // Unified persistence (checkpoints + memories) — ADR-011
  // ─────────────────────────────────────────────────────────────────

  // GET /api/agents/:scope/:name/persistence?kind=&actorType=&actorId=
  // Read the unified persistence rows visible to the caller.
  router.get(
    "/:scope{@[^/]+}/:name/persistence",
    requireAgent(),
    requirePermission("persistence", "read"),
    async (c) => {
      const agent = c.get("agent");
      const applicationId = c.get("applicationId");
      const kindParam = c.req.query("kind");
      const actorTypeParam = c.req.query("actorType");
      const actorIdParam = c.req.query("actorId");
      const runIdParam = c.req.query("runId");

      // Default scope = caller's actor. Admin filtering by other actors
      // is controlled by `persistence:read` (admin-grade); members see
      // their own actor's view through this endpoint.
      const callerScope = scopeFromActor(getActor(c));

      // Optional explicit scope override (admin only — the requirePermission
      // gate above gates the route; a member who somehow had `persistence:read`
      // would still see only their own data because we don't honour overrides
      // for members. Guard:
      const isAdmin = c.get("orgRole") === "admin" || c.get("orgRole") === "owner";

      const scopeOverride = isAdmin ? scopeFromQueryParams(actorTypeParam, actorIdParam) : null;
      const scope = scopeOverride ?? callerScope;

      const wantsPinned = !kindParam || kindParam === "pinned";
      const wantsMemory = !kindParam || kindParam === "memory";
      if (kindParam && !wantsPinned && !wantsMemory) {
        throw invalidRequest("kind must be 'pinned' or 'memory'");
      }

      // Admins inspecting at agent-level (no scope override, no runId) see
      // every actor's pinned slots; everyone else is narrowed to their scope.
      const pinnedScope = isAdmin && !scopeOverride ? undefined : scope;

      const [pinned, memories] = await Promise.all([
        wantsPinned
          ? listPinnedSlots(agent.id, applicationId, pinnedScope, runIdParam)
          : Promise.resolve([]),
        wantsMemory
          ? listMemories(agent.id, applicationId, scope, runIdParam)
          : Promise.resolve([]),
      ]);

      return c.json({
        pinned: wantsPinned
          ? pinned.map((slot) => ({
              id: slot.id,
              key: slot.key,
              content: slot.content,
              runId: slot.runId,
              actorType: slot.actorType,
              actorId: slot.actorId,
              createdAt: slot.createdAt?.toISOString() ?? null,
              updatedAt: slot.updatedAt?.toISOString() ?? null,
            }))
          : undefined,
        memories: wantsMemory
          ? memories.map((m) => ({
              id: m.id,
              content: m.content,
              runId: m.runId,
              actorType: m.actorType,
              actorId: m.actorId,
              pinned: m.pinned,
              createdAt: m.createdAt?.toISOString() ?? null,
            }))
          : undefined,
      });
    },
  );

  // DELETE /api/agents/:scope/:name/persistence/memories/:id
  router.delete(
    "/:scope{@[^/]+}/:name/persistence/memories/:id",
    requireAgent(),
    requirePermission("persistence", "delete"),
    async (c) => {
      const agent = c.get("agent");
      const applicationId = c.get("applicationId");
      const result = z.coerce.number().int().min(1).safeParse(c.req.param("id"));
      if (!result.success) {
        throw invalidRequest("Invalid memory id", "id");
      }
      const deleted = await deleteMemory(result.data, agent.id, applicationId);
      if (!deleted) {
        throw notFound("Memory not found");
      }
      return c.json({ deleted: true });
    },
  );

  // DELETE /api/agents/:scope/:name/persistence/pinned/:id
  router.delete(
    "/:scope{@[^/]+}/:name/persistence/pinned/:id",
    requireAgent(),
    requirePermission("persistence", "delete"),
    async (c) => {
      const agent = c.get("agent");
      const applicationId = c.get("applicationId");
      const result = z.coerce.number().int().min(1).safeParse(c.req.param("id"));
      if (!result.success) {
        throw invalidRequest("Invalid pinned slot id", "id");
      }
      const deleted = await deletePinnedSlotById(result.data, agent.id, applicationId);
      if (!deleted) {
        throw notFound("Pinned slot not found");
      }
      return c.json({ deleted: true });
    },
  );

  // DELETE /api/agents/:scope/:name/persistence?kind=&actorType=&actorId=
  // Bulk delete: by default wipes every memory + checkpoint for the agent
  // in this app. Narrow with query params.
  router.delete(
    "/:scope{@[^/]+}/:name/persistence",
    requireAgent(),
    requirePermission("persistence", "delete"),
    async (c) => {
      const agent = c.get("agent");
      const applicationId = c.get("applicationId");
      const kindParam = c.req.query("kind");
      const actorTypeParam = c.req.query("actorType");
      const actorIdParam = c.req.query("actorId");

      const scope = scopeFromQueryParams(actorTypeParam, actorIdParam) ?? undefined;

      let memoriesDeleted = 0;
      let checkpointDeleted = false;

      if (!kindParam || kindParam === "memory") {
        memoriesDeleted = await deleteAllMemories(agent.id, applicationId, scope);
      }
      if ((!kindParam || kindParam === "pinned") && scope) {
        // Checkpoint slot is upserted per-scope; require an explicit scope here.
        // (Bulk-delete of every pinned slot key is intentionally not exposed —
        // each named slot must be deleted individually via DELETE /pinned/:id.)
        checkpointDeleted = await deleteCheckpoint(agent.id, applicationId, scope);
      }

      return c.json({ memoriesDeleted, checkpointDeleted });
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
