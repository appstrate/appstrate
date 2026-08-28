// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { Context } from "hono";
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
import { validateAgainstSchema } from "../services/schema.ts";
import { assertLockedFieldsSatisfiable } from "../services/input-resolution.ts";
import { dropLockedFieldsFromSchedules } from "../services/scheduler.ts";
import {
  listAccessiblePackages,
  updateInstalledPackage,
  getInstalledPackageSettings,
  hasPackageAccess,
} from "../services/space-packages.ts";
import { getPackage } from "../services/package-catalog.ts";
import { asRecord } from "@appstrate/core/safe-json";
import type { AgentManifest } from "../types/index.ts";
import { requireAgent } from "../middleware/guards.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getActor } from "../lib/actor.ts";
import { parseScopedName } from "@appstrate/core/naming";
import { computeIntegrity } from "@appstrate/core/integrity";
import { z } from "zod";
import { ApiError, forbidden, invalidRequest, notFound, validationFailed } from "../lib/errors.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { getSpaceScope } from "../lib/scope.ts";
import { resolveAgentConnectionReadiness } from "../services/integration-pins-service.ts";
import {
  assertExplicitModelExists,
  resolveModel,
  validateGenerationOverride,
} from "../services/org-models.ts";
import {
  buildBundleForAgentExport,
  buildBundleFromAgentDraft,
  resolveExportVersion,
} from "../services/bundle-assembly.ts";
import { writeBundleToBuffer, type Bundle } from "@appstrate/afps-runtime/bundle";
import { toBundleApiError } from "../services/run-launcher/bundle-error-mapping.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import { SCOPED_PACKAGE_ROUTE } from "./scoped-package-route.ts";
import {
  modelGenerationSettingsSchema,
  reconcileModelGenerationSettings,
} from "@appstrate/core/model-generation";
export const proxyIdSchema = z.object({ proxyId: z.string().nullable() }).strict();
export const modelIdSchema = z
  .object({
    modelId: z.string().nullable(),
    generation: modelGenerationSettingsSchema.nullable().optional(),
  })
  .strict();

/**
 * Body of `PUT /api/agents/{scope}/{name}/input-settings` — the agent's stored
 * input settings for this space.
 *
 * `values` are layer 2 of the input resolution (editor defaults, partial by
 * design); `locked_fields` names the input fields no caller may set at
 * launch. Both are full replacements, not patches: the editor form owns the
 * whole document, so an omitted key means "cleared", never "unchanged".
 *
 * Both members are therefore MANDATORY and the object is `.strict()`: a body
 * that omits one, or that carries an unknown key, is a 400 rather than a
 * silent erasure of the stored values and locks.
 */
export const agentInputSettingsSchema = z
  .object({
    values: z.record(z.string(), z.unknown()),
    locked_fields: z.array(z.string().min(1)),
  })
  .strict();

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

/**
 * Read guards for the package types a bundle can carry BEYOND its root.
 *
 * Both export paths walk `depTypes: ["skills"]`, so `skill` is the only type
 * that can appear today. Anything else fails CLOSED — an archive must never
 * ship bytes whose read scope this route does not name.
 */
const BUNDLE_DEPENDENCY_READ_GUARDS = new Map<string, ReturnType<typeof requirePermission>>([
  ["skill", requirePermission("skills", "read")],
]);

/**
 * Authorize the DEPENDENCY bytes an export is about to hand out.
 *
 * `agents:read` covers the root agent, whose files the export narrows to
 * `manifest.json` + `prompt.md`. Dependencies are a different surface: both
 * catalogs put a dependency's ENTIRE stored file map into the archive
 * (`DraftPackageCatalog.fetch` reads `downloadPackageFiles` whole,
 * `DbPackageCatalog.fetch` extracts the whole published artifact). A bundle
 * carrying a skill therefore hands out exactly the bytes
 * `GET /api/packages/{scope}/{name}/files[/content]` serves — and #1123/#1124
 * settled that those need `skills:read`, resolved per package TYPE rather than
 * one blanket scope. Without this guard the export is a looser door to the same
 * bytes: an `agents:read`-only credential is 403'd on the file explorer and
 * served the identical content here.
 *
 * Checked against the ASSEMBLED bundle, not the root manifest, so transitive
 * deps and any future widening of `depTypes` are covered by construction.
 *
 * Visibility is deliberately NOT re-derived here. Dependency resolution is
 * org-scoped in every catalog, which is what lets a run reach a skill that is
 * not installed in the current space; re-checking `hasPackageAccess` over
 * the dep set would make the export stricter than the run it mirrors and break
 * `appstrate run @scope/agent` where clicking Run in the dashboard succeeds.
 * Scope, not visibility, is what this route was missing.
 */
async function requireBundleDependencyReadPermissions(
  c: Context<AppEnv>,
  bundle: Bundle,
): Promise<void> {
  const checked = new Set<string>();
  for (const [identity, pkg] of bundle.packages) {
    if (identity === bundle.root) continue;
    const rawType = asRecord(pkg.manifest).type;
    const type = typeof rawType === "string" ? rawType : "";
    if (checked.has(type)) continue;
    checked.add(type);
    const guard = BUNDLE_DEPENDENCY_READ_GUARDS.get(type);
    if (!guard) {
      throw forbidden(
        `Insufficient permissions: the bundle carries a '${type || "unknown"}' dependency and no read scope is defined for that type`,
      );
    }
    // `requirePermission` is middleware; invoking it with a no-op `next`
    // reuses the same 403 shape, denial audit hook, and fail-closed semantics
    // as every route-level RBAC call site.
    await guard(c, async () => {});
  }
}

export function createAgentsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/agents — list agents accessible to the current space
  router.get("/", requirePermission("agents", "read"), async (c) => {
    const scope = getSpaceScope(c);

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

  // PUT /api/agents/:scope/:name/input-settings — save the agent's stored
  // input defaults + field locks (admin-only).
  router.put(
    `/${SCOPED_PACKAGE_ROUTE}/input-settings`,
    requireAgent(),
    requirePermission("agents", "configure"),
    async (c) => {
      const agent = c.get("package");

      const body = await readJsonBody(c, agentInputSettingsSchema);
      const schema = asJSONSchemaObject(
        agent.manifest.input?.schema ?? { type: "object" as const, properties: {} },
      );

      // `values` is the WHOLE stored document, and the editor form that owns it
      // only ever renders the properties `input.schema` declares. A key naming
      // no declared property is therefore invisible in the UI and un-removable:
      // the settings form re-submits what it was handed, and the launch form
      // seeds it as caller input on every run. Prune it to the declared keys.
      //
      // This is NOT the "silent drop of a caller value"
      // `@appstrate/core/input-resolution`'s `assertFieldsUnlocked` refuses: that
      // rule protects a value a CALLER sent for a field that
      // exists. Here the editor is replacing the entire stored document, and a
      // key that matches no declared property has nothing to resolve into —
      // keeping it only poisons every launch.
      //
      // Pruning BEFORE validation is also what keeps an
      // `additionalProperties: false` schema saveable: an orphan key left in
      // place would 400 here forever, locking the editor out of its own row.
      const declaredProperties = new Set(Object.keys(schema.properties ?? {}));
      const values = Object.fromEntries(
        Object.entries(body.values).filter(([key]) => declaredProperties.has(key)),
      );

      // Stored values are a partial layer: a required field the editor leaves
      // empty is legitimately asked at launch. Validate types/formats against
      // the input schema with `required` dropped, so a wrong-typed default is
      // still rejected here rather than at every run.
      const validation = validateAgainstSchema(values, { ...schema, required: [] });
      if (!validation.valid) {
        throw validationFailed(
          validation.errors.map((e) => ({
            field: e.field ? `values.${e.field}` : "values",
            code: "invalid_input",
            title: "Invalid Input",
            message: e.message,
          })),
        );
      }

      // A required field locked with no value behind it is invisible at launch
      // AND unsatisfiable — every run would fail and nobody could see why.
      assertLockedFieldsSatisfiable(schema, body.locked_fields, values);

      const scope = getSpaceScope(c);
      await updateInstalledPackage(scope, agent.id, {
        inputSettings: { values, locked: body.locked_fields },
      });

      // Reconcile the schedules the new lock set just invalidated. A schedule
      // that froze a now-locked field would otherwise fail `locked_input_field`
      // on every tick forever — the schedule is not disabled by a failed fire.
      // Its frozen value is dropped so the field re-resolves from the editor
      // value, which is what a fresh launch does.
      await dropLockedFieldsFromSchedules(scope, agent.id, body.locked_fields);

      await recordAuditFromContext(c, {
        action: "agent.input_settings_updated",
        resourceType: "agent",
        resourceId: agent.id,
        after: { locked: body.locked_fields },
      });

      // 200 + the bare persisted resource (#657): validation failures are
      // 400s, so a 200 needs no valid:true scrap.
      return c.json({ values, locked_fields: body.locked_fields });
    },
  );

  // GET /api/agents/:scope/:name/proxy — get agent proxy configuration.
  // Permission BEFORE `requireAgent()`: that middleware 404s on an unknown
  // agent, so the reverse order answers "does this agent exist?" to a caller
  // that is not allowed to read agents at all.
  router.get(
    `/${SCOPED_PACKAGE_ROUTE}/proxy`,
    requirePermission("agents", "read"),
    requireAgent(),
    async (c) => {
      const agent = c.get("package");
      const spaceId = c.get("spaceId");
      const { proxyId } = await getInstalledPackageSettings(spaceId, agent.id);

      return c.json({ proxyId, resolved: proxyId !== "none" });
    },
  );

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
          scope: getSpaceScope(c),
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
      const scope = getSpaceScope(c);
      const data = await readJsonBody(c, proxyIdSchema);

      await updateInstalledPackage(scope, agent.id, { proxyId: data.proxyId });

      await recordAuditFromContext(c, {
        action: "agent.proxy_updated",
        resourceType: "agent",
        resourceId: agent.id,
        after: { proxyId: data.proxyId },
      });

      // Return the bare proxy-setting resource — same shape and read path
      // (`getInstalledPackageSettings`) as GET /agents/:scope/:name/proxy (#657).
      const { proxyId } = await getInstalledPackageSettings(scope.spaceId, agent.id);
      return c.json({ proxyId, resolved: proxyId !== "none" });
    },
  );

  // GET /api/agents/:scope/:name/model — get agent model configuration.
  // Permission-first, same reason as `…/proxy` above.
  router.get(
    `/${SCOPED_PACKAGE_ROUTE}/model`,
    requirePermission("agents", "read"),
    requireAgent(),
    async (c) => {
      const agent = c.get("package");
      const spaceId = c.get("spaceId");
      const { modelId, generationConfig } = await getInstalledPackageSettings(spaceId, agent.id);

      return c.json({ modelId, generation: generationConfig });
    },
  );

  // PUT /api/agents/:scope/:name/model — set agent model override (admin-only)
  router.put(
    `/${SCOPED_PACKAGE_ROUTE}/model`,
    requireAgent(),
    requirePermission("agents", "configure"),
    async (c) => {
      const agent = c.get("package");
      const scope = getSpaceScope(c);
      const data = await readJsonBody(c, modelIdSchema);

      // Reject unknown/cross-org ids like run and schedule overrides do (#960); null clears.
      const current = await getInstalledPackageSettings(scope.spaceId, agent.id);
      const explicitModel = await assertExplicitModelExists(scope.orgId, data.modelId);
      const selectedModel =
        explicitModel ?? (await resolveModel(scope.orgId, agent.id, data.modelId));
      let generation = data.generation;
      if (generation && Object.keys(generation).length > 0) {
        generation = validateGenerationOverride(generation, selectedModel, "generation");
      } else if (generation === undefined && current.generationConfig) {
        // `modelId` is REQUIRED on this body, so "the model may have changed"
        // — the precondition the other two routes spell out as
        // `modelId !== undefined` — always holds here. See `spaces.ts`.
        generation = reconcileModelGenerationSettings(
          current.generationConfig,
          selectedModel?.generation,
        );
      }

      await updateInstalledPackage(scope, agent.id, {
        modelId: data.modelId,
        ...(generation !== undefined ? { generationConfig: generation } : {}),
      });

      await recordAuditFromContext(c, {
        action: "agent.model_updated",
        resourceType: "agent",
        resourceId: agent.id,
        after: { modelId: data.modelId, generation },
      });

      // Return the bare model-setting resource — same shape and read path
      // (`getInstalledPackageSettings`) as GET /agents/:scope/:name/model (#657).
      const { modelId, generationConfig } = await getInstalledPackageSettings(
        scope.spaceId,
        agent.id,
      );
      return c.json({ modelId, generation: generationConfig });
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
      const spaceId = c.get("spaceId");
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
          ? listPinnedSlots(agent.id, spaceId, pinnedScope, runIdParam)
          : Promise.resolve([]),
        wantsMemory ? listMemories(agent.id, spaceId, scope, runIdParam) : Promise.resolve([]),
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
      const spaceId = c.get("spaceId");
      const result = z.coerce.number().int().min(1).safeParse(c.req.param("id"));
      if (!result.success) {
        throw invalidRequest("Invalid memory id", "id");
      }
      const deleted = await deleteMemory(result.data, agent.id, spaceId);
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
      const spaceId = c.get("spaceId");
      const result = z.coerce.number().int().min(1).safeParse(c.req.param("id"));
      if (!result.success) {
        throw invalidRequest("Invalid pinned slot id", "id");
      }
      const deleted = await deletePinnedSlotById(result.data, agent.id, spaceId);
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
  // in this space. Narrow with query params.
  router.delete(
    `/${SCOPED_PACKAGE_ROUTE}/persistence`,
    requireAgent(),
    requirePermission("persistence", "delete"),
    async (c) => {
      const agent = c.get("package");
      const spaceId = c.get("spaceId");
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
        memoriesDeleted = await deleteAllMemories(agent.id, spaceId, scope);
      }
      if ((!kindParam || kindParam === "pinned") && scope) {
        // Checkpoint slot is upserted per-scope; require an explicit scope here.
        // (Bulk-delete of every pinned slot key is intentionally not exposed —
        // each named slot must be deleted individually via DELETE /pinned/:id.)
        checkpointDeleted = await deleteCheckpoint(agent.id, spaceId, scope);
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
  // "doesn't exist in org" and "exists in org but not installed in space"
  // into a single opaque 404. The CLI's run-by-id flow needs to tell the
  // two cases apart so it can prompt the user to install rather than
  // suggest the package is mistyped. Inline check below distinguishes
  // them via `agent_not_installed_in_space`.
  router.get(
    `/${SCOPED_PACKAGE_ROUTE}/bundle`,
    rateLimit(30),
    requirePermission("agents", "read"),
    async (c) => {
      const scopeParam = c.req.param("scope")!;
      const nameParam = c.req.param("name")!;
      const packageId = `${scopeParam}/${nameParam}`;
      const orgId = c.get("orgId");
      const spaceId = c.get("spaceId")!;
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
      if (!(await hasPackageAccess({ orgId, spaceId }, packageId))) {
        throw new ApiError({
          status: 404,
          code: "agent_not_installed_in_space",
          title: "Agent Not Installed",
          detail:
            `Agent '${packageId}' exists in this organization but is not installed in space '${spaceId}'. ` +
            `Install it via POST /api/spaces/${spaceId}/packages, or pick a different space.`,
        });
      }
      const scope = getSpaceScope(c);

      // Omit time-varying metadata (createdAt) so two exports of the same
      // (package, version) produce byte-identical archives — this makes
      // the export cache-friendly and the determinism contract explicit.
      // The resolved version is surfaced in `X-Bundle-Version` so the CLI
      // can attribute the run to a concrete version label without parsing
      // the manifest itself (and without trusting a tag that may have moved
      // between bundle download and run creation).
      let versionLabel: string;
      let bytes: Uint8Array;
      try {
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
        // The archive carries every dependency's full stored file map, which
        // `agents:read` does not authorize. Gate on the read scope of each
        // dependency TYPE before any bytes are serialised, so this route is not
        // a looser door to the same content the package file explorer guards.
        await requireBundleDependencyReadPermissions(c, bundle);
        // Serialization stays inside the try: `writeBundleToBuffer` re-validates
        // the assembled map and raises the same `BundleError` family, so leaving
        // it outside would keep that throw on the untyped path.
        bytes = writeBundleToBuffer(bundle);
      } catch (err) {
        // Export reads the same stored artifacts a run does and reaches
        // dependencies through the same catalog, so it raises the same
        // bundle-layer errors. Map them onto the RFC 9457 contract the run path
        // already uses; without this they reach the global handler as an opaque
        // `500 internal_error`.
        //
        // Anything the mapper does not own returns null and rethrows untouched,
        // keeping its own status — the 404s from `resolveExportVersion`, the 400
        // from an invalid draft manifest, the 403 from the dependency read-scope
        // guard above.
        const mapped = toBundleApiError(err);
        if (mapped) throw mapped;
        throw err;
      }
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
