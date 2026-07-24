// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { listResponse } from "../lib/list-response.ts";
import { getRunningRunCounts } from "../services/state/runs.ts";
import {
  listPinnedSlots,
  listMemories,
  deleteMemory,
  deleteAllMemories,
  deleteCheckpoint,
  deletePinnedSlotById,
  scopeFromActor,
  type PersistenceScope,
} from "../services/state/package-persistence.ts";
import { validateConfig } from "../services/schema.ts";
import {
  listAccessiblePackages,
  updateInstalledPackage,
  getPackageConfig,
  hasPackageAccess,
} from "../services/application-packages.ts";
import { getPackage } from "../services/package-catalog.ts";
import { asRecord } from "@appstrate/core/safe-json";
import type { AgentManifest } from "../types/index.ts";
import { requireAgent } from "../middleware/guards.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getActor } from "../lib/actor.ts";
import { parseScopedName } from "@appstrate/core/naming";
import { computeIntegrity } from "@appstrate/core/integrity";
import { z } from "zod";
import { ApiError, invalidRequest, notFound } from "../lib/errors.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { asJSONSchemaObject, mergeWithDefaults } from "@appstrate/core/form";
import { getAppScope } from "../lib/scope.ts";
import { resolveAgentConnectionReadiness } from "../services/integration-pins-service.ts";
import { assertExplicitModelExists } from "../services/org-models.ts";
import {
  buildBundleForAgentExport,
  buildBundleFromAgentDraft,
  resolveExportVersion,
} from "../services/bundle-assembly.ts";
import { writeBundleToBuffer } from "@appstrate/afps-runtime/bundle";
import { rateLimit } from "../middleware/rate-limit.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import { SCOPED_PACKAGE_ROUTE } from "./scoped-package-route.ts";
export const proxyIdSchema = z.object({ proxyId: z.string().nullable() });
export const modelIdSchema = z.object({ modelId: z.string().nullable() });

/**
 * Parse the `actor_type` / `actor_id` query-param pair shared by the
 * persistence GET / DELETE routes into a {@link PersistenceScope}.
 * Returns `null` when the caller did not supply `actor_type` (i.e. no
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
    return { type: "user", id: actorIdParam };
  }
  if (actorTypeParam === "end_user" && actorIdParam) {
    return { type: "end_user", id: actorIdParam };
  }
  throw invalidRequest("Invalid actor_type / actor_id combination");
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
        display_name: manifest.display_name,
        description: manifest.description,
        schema_version: manifest.schema_version,
        author: manifest.author,
        keywords: manifest.keywords ?? [],
        dependencies: {
          skills: (manifest.dependencies?.skills ?? {}) as Record<string, string>,
          mcp_servers: (manifest.dependencies?.mcp_servers ?? {}) as Record<string, string>,
          integrations: (manifest.dependencies?.integrations ?? {}) as Record<string, string>,
        },
        running_runs: runningCounts[row.id] ?? 0,
        source: row.source ?? "local",
        // Canonical scope format includes the `@` sigil (e.g. "@myorg") so
        // list output is directly usable as `{scope}` path-param input — one
        // operation's output must be valid input for the next (issue #629).
        scope: parsed ? `@${parsed.scope}` : null,
        // `version` from the manifest may be absent on a partial draft; the DB
        // `type` column is NOT NULL and authoritative (manifest JSONB can lie).
        version: manifest.version ?? null,
        type: row.type,
      };
    });

    return c.json(listResponse(agentList));
  });

  // PUT /api/agents/:scope/:name/config — save agent configuration (admin-only)
  router.put(
    `/${SCOPED_PACKAGE_ROUTE}/config`,
    requireAgent(),
    requirePermission("agents", "configure"),
    async (c) => {
      const agent = c.get("package");

      const body = await readJsonBody(c, z.record(z.string(), z.unknown()));
      const schema = agent.manifest.config?.schema ?? { type: "object" as const, properties: {} };

      // Validate config with AJV
      const validation = validateConfig(body, asJSONSchemaObject(schema));
      if (!validation.valid) {
        throw invalidRequest("Invalid configuration");
      }

      const config = mergeWithDefaults(asJSONSchemaObject(schema), body);

      const scope = getAppScope(c);
      await updateInstalledPackage(scope, agent.id, { config });

      await recordAuditFromContext(c, {
        action: "agent.config_updated",
        resourceType: "agent",
        resourceId: agent.id,
      });

      // 200 + the bare persisted configuration document (merged with schema
      // defaults) — the resource itself, no `validation` echo (#657):
      // validation failures are 400s, a 200 needs no valid:true scrap.
      return c.json(config);
    },
  );

  // GET /api/agents/:scope/:name/proxy — get agent proxy configuration
  router.get(`/${SCOPED_PACKAGE_ROUTE}/proxy`, requireAgent(), async (c) => {
    const agent = c.get("package");
    const applicationId = c.get("applicationId");
    const { proxyId } = await getPackageConfig(applicationId, agent.id);

    return c.json({ proxyId, resolved: proxyId !== "none" });
  });

  // GET /api/agents/:scope/:name/connection-readiness — bulk integration
  // connection readiness for the agent: authoritative run-blocking verdict
  // (identical to the run-kickoff 412) + per-integration management DTO.
  router.get(
    `/${SCOPED_PACKAGE_ROUTE}/connection-readiness`,
    requireAgent(),
    requirePermission("integrations", "read"),
    async (c) => {
      const agent = c.get("package");
      const role = c.get("orgRole");
      return c.json(
        await resolveAgentConnectionReadiness({
          scope: getAppScope(c),
          agentPackageId: agent.id,
          actor: getActor(c),
          isAdmin: role === "owner" || role === "admin",
          version: c.req.query("version"),
        }),
      );
    },
  );

  // PUT /api/agents/:scope/:name/proxy — set agent proxy override (admin-only)
  router.put(
    `/${SCOPED_PACKAGE_ROUTE}/proxy`,
    requireAgent(),
    requirePermission("agents", "configure"),
    async (c) => {
      const agent = c.get("package");
      const scope = getAppScope(c);
      const data = await readJsonBody(c, proxyIdSchema);

      await updateInstalledPackage(scope, agent.id, { proxyId: data.proxyId });

      await recordAuditFromContext(c, {
        action: "agent.proxy_updated",
        resourceType: "agent",
        resourceId: agent.id,
        after: { proxyId: data.proxyId },
      });

      // Return the bare proxy-setting resource — same shape and read path
      // (`getPackageConfig`) as GET /agents/:scope/:name/proxy (#657).
      const { proxyId } = await getPackageConfig(scope.applicationId, agent.id);
      return c.json({ proxyId, resolved: proxyId !== "none" });
    },
  );

  // GET /api/agents/:scope/:name/model — get agent model configuration
  router.get(`/${SCOPED_PACKAGE_ROUTE}/model`, requireAgent(), async (c) => {
    const agent = c.get("package");
    const applicationId = c.get("applicationId");
    const { modelId } = await getPackageConfig(applicationId, agent.id);

    return c.json({ modelId });
  });

  // PUT /api/agents/:scope/:name/model — set agent model override (admin-only)
  router.put(
    `/${SCOPED_PACKAGE_ROUTE}/model`,
    requireAgent(),
    requirePermission("agents", "configure"),
    async (c) => {
      const agent = c.get("package");
      const scope = getAppScope(c);
      const data = await readJsonBody(c, modelIdSchema);

      // Reject unknown or cross-org model ids up front (#960) — same contract
      // as explicit run/schedule overrides. `null` stays valid to clear the
      // override; the resolveModel() fallback remains only for references
      // that go stale after being written.
      await assertExplicitModelExists(scope.orgId, data.modelId);

      await updateInstalledPackage(scope, agent.id, { modelId: data.modelId });

      await recordAuditFromContext(c, {
        action: "agent.model_updated",
        resourceType: "agent",
        resourceId: agent.id,
        after: { modelId: data.modelId },
      });

      // Return the bare model-setting resource — same shape and read path
      // (`getPackageConfig`) as GET /agents/:scope/:name/model (#657).
      const { modelId } = await getPackageConfig(scope.applicationId, agent.id);
      return c.json({ modelId });
    },
  );

  // ─────────────────────────────────────────────────────────────────
  // Unified persistence (checkpoints + memories)
  // ─────────────────────────────────────────────────────────────────

  // GET /api/agents/:scope/:name/persistence?kind=&actor_type=&actor_id=
  // Read the unified persistence rows visible to the caller.
  router.get(
    `/${SCOPED_PACKAGE_ROUTE}/persistence`,
    requireAgent(),
    requirePermission("persistence", "read"),
    async (c) => {
      const agent = c.get("package");
      const applicationId = c.get("applicationId");
      const kindParam = c.req.query("kind");
      const actorTypeParam = c.req.query("actor_type");
      const actorIdParam = c.req.query("actor_id");
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
              actor_type: slot.actorType,
              actor_id: slot.actorId,
              createdAt: slot.createdAt?.toISOString() ?? null,
              updatedAt: slot.updatedAt?.toISOString() ?? null,
            }))
          : undefined,
        memories: wantsMemory
          ? memories.map((m) => ({
              id: m.id,
              content: m.content,
              runId: m.runId,
              actor_type: m.actorType,
              actor_id: m.actorId,
              pinned: m.pinned,
              createdAt: m.createdAt?.toISOString() ?? null,
            }))
          : undefined,
      });
    },
  );

  // DELETE /api/agents/:scope/:name/persistence/memories/:id
  router.delete(
    `/${SCOPED_PACKAGE_ROUTE}/persistence/memories/:id`,
    requireAgent(),
    requirePermission("persistence", "delete"),
    async (c) => {
      const agent = c.get("package");
      const applicationId = c.get("applicationId");
      const result = z.coerce.number().int().min(1).safeParse(c.req.param("id"));
      if (!result.success) {
        throw invalidRequest("Invalid memory id", "id");
      }
      const deleted = await deleteMemory(result.data, agent.id, applicationId);
      if (!deleted) {
        throw notFound("Memory not found");
      }
      await recordAuditFromContext(c, {
        action: "agent.memory_deleted",
        resourceType: "agent",
        resourceId: agent.id,
        after: { memoryId: result.data },
      });
      return c.body(null, 204);
    },
  );

  // DELETE /api/agents/:scope/:name/persistence/pinned/:id
  router.delete(
    `/${SCOPED_PACKAGE_ROUTE}/persistence/pinned/:id`,
    requireAgent(),
    requirePermission("persistence", "delete"),
    async (c) => {
      const agent = c.get("package");
      const applicationId = c.get("applicationId");
      const result = z.coerce.number().int().min(1).safeParse(c.req.param("id"));
      if (!result.success) {
        throw invalidRequest("Invalid pinned slot id", "id");
      }
      const deleted = await deletePinnedSlotById(result.data, agent.id, applicationId);
      if (!deleted) {
        throw notFound("Pinned slot not found");
      }
      await recordAuditFromContext(c, {
        action: "agent.pinned_slot_deleted",
        resourceType: "agent",
        resourceId: agent.id,
        after: { pinnedSlotId: result.data },
      });
      return c.body(null, 204);
    },
  );

  // DELETE /api/agents/:scope/:name/persistence?kind=&actor_type=&actor_id=
  // Bulk delete: by default wipes every memory + checkpoint for the agent
  // in this app. Narrow with query params.
  router.delete(
    `/${SCOPED_PACKAGE_ROUTE}/persistence`,
    requireAgent(),
    requirePermission("persistence", "delete"),
    async (c) => {
      const agent = c.get("package");
      const applicationId = c.get("applicationId");
      const kindParam = c.req.query("kind");
      const actorTypeParam = c.req.query("actor_type");
      const actorIdParam = c.req.query("actor_id");

      // Same actor-override guard the GET path applies: only admins/owners may
      // target another actor's rows (or omit the scope to bulk-wipe every
      // actor). A member — even one holding `persistence:delete` — is narrowed
      // to their own actor scope, so they cannot delete another actor's
      // memories/checkpoints by supplying an arbitrary actor_type / actor_id.
      const callerScope = scopeFromActor(getActor(c));
      const isAdmin = c.get("orgRole") === "admin" || c.get("orgRole") === "owner";
      const scopeOverride = isAdmin ? scopeFromQueryParams(actorTypeParam, actorIdParam) : null;
      const scope = isAdmin ? (scopeOverride ?? undefined) : callerScope;

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

      await recordAuditFromContext(c, {
        action: "agent.persistence_bulk_deleted",
        resourceType: "agent",
        resourceId: agent.id,
        after: {
          kind: kindParam ?? "all",
          actorType: actorTypeParam ?? null,
          actorId: actorIdParam ?? null,
          memoriesDeleted,
          checkpointDeleted,
        },
      });

      return c.json({
        memories_deleted: memoriesDeleted,
        checkpoint_deleted: checkpointDeleted,
      });
    },
  );

  // GET /api/agents/:scope/:name/bundle — export the agent as an .afps-bundle
  // (multi-package archive with pinned versions of every transitive dep).
  //
  // We deliberately don't use `requireAgent()` here: that middleware folds
  // "doesn't exist in org" and "exists in org but not installed in app"
  // into a single opaque 404. The CLI's run-by-id flow needs to tell the
  // two cases apart so it can prompt the user to install rather than
  // suggest the package is mistyped. Inline check below distinguishes
  // them via `agent_not_installed_in_app`.
  router.get(
    `/${SCOPED_PACKAGE_ROUTE}/bundle`,
    rateLimit(30),
    requirePermission("agents", "read"),
    async (c) => {
      const scopeParam = c.req.param("scope")!;
      const nameParam = c.req.param("name")!;
      const packageId = `${scopeParam}/${nameParam}`;
      const orgId = c.get("orgId");
      const applicationId = c.get("applicationId")!;
      const versionSpec = c.req.query("version") ?? null;
      const sourceQuery = c.req.query("source");
      // `source=draft` mirrors the dashboard "Run" button: bundle the
      // agent's current draft state instead of a published version. The
      // CLI's run-by-id flow uses it so `appstrate run @scope/agent`
      // works on never-published agents — same UX as clicking Run in
      // the UI. Default stays `published` so the existing dashboard
      // export flow (download a published archive) is unchanged.
      // `version=…` is mutually exclusive with `source=draft`.
      if (sourceQuery && sourceQuery !== "draft" && sourceQuery !== "published") {
        throw new ApiError({
          status: 400,
          code: "invalid_source",
          title: "Invalid Source",
          detail: `?source must be 'draft' or 'published' (got '${sourceQuery}')`,
        });
      }
      const useDraft = sourceQuery === "draft";
      if (useDraft && versionSpec) {
        throw new ApiError({
          status: 400,
          code: "draft_with_version",
          title: "Conflicting Query",
          detail: "?source=draft cannot be combined with ?version — drafts have no published id",
        });
      }

      const agent = await getPackage(packageId, orgId);
      if (!agent) {
        throw new ApiError({
          status: 404,
          code: "agent_not_found",
          title: "Agent Not Found",
          detail: `Agent '${packageId}' not found in this organization`,
        });
      }
      if (!(await hasPackageAccess({ orgId, applicationId }, packageId))) {
        throw new ApiError({
          status: 404,
          code: "agent_not_installed_in_app",
          title: "Agent Not Installed",
          detail:
            `Agent '${packageId}' exists in this organization but is not installed in application '${applicationId}'. ` +
            `Install it via POST /api/applications/${applicationId}/packages, or pick a different application.`,
        });
      }
      const scope = getAppScope(c);

      // Omit time-varying metadata (createdAt) so two exports of the same
      // (package, version) produce byte-identical archives — this makes
      // the export cache-friendly and the determinism contract explicit.
      // The resolved version is surfaced in `X-Bundle-Version` so the CLI
      // can attribute the run to a concrete version label without parsing
      // the manifest itself (and without trusting a tag that may have moved
      // between bundle download and run creation).
      let versionLabel: string;
      let bundle;
      if (useDraft) {
        bundle = await buildBundleFromAgentDraft(agent, scope, { builder: "appstrate-platform" });
        versionLabel = "draft";
      } else {
        versionLabel = await resolveExportVersion(agent.id, scope, versionSpec);
        bundle = await buildBundleForAgentExport(agent.id, scope, {
          versionSpec: versionLabel,
          metadata: { builder: "appstrate-platform" },
        });
      }

      const bytes = writeBundleToBuffer(bundle);
      const parsed = parseScopedName(agent.id);
      const safeName = parsed ? `${parsed.scope}-${parsed.name}` : "bundle";

      // X-Bundle-Integrity is the SHA256 of the wire bytes — the CLI
      // recomputes the same digest on the downloaded archive to detect
      // transport-level corruption (proxies, CDN, partial reads). The
      // in-archive `bundle.integrity` field is a different, AFPS-spec
      // contract (canonical packages-map JSON SRI) and intentionally
      // does not equal the zip-bytes SHA — sending it as the header
      // would always trip `integrity_mismatch` on a clean download.
      const wireIntegrity = computeIntegrity(new Uint8Array(bytes));

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
          "X-Bundle-Integrity": wireIntegrity,
          "X-Bundle-Version": versionLabel,
        },
      });
    },
  );

  return router;
}
