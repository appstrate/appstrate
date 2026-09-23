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
  listActivePackages,
  updateSpacePackage,
  getSpacePackageSettings,
} from "../services/space-packages.ts";
import { resolveAgentRunVersion } from "../services/agent-version-resolver.ts";
import { asRecord } from "@appstrate/core/safe-json";
import type { AgentManifest } from "../types/index.ts";
import { requireActiveAgent, requireAgent } from "../middleware/guards.ts";
import { requirePermission, rowAuthority } from "../middleware/require-permission.ts";
import { getActor } from "../lib/actor.ts";
import { runVisibilityFilter } from "../lib/run-visibility.ts";
import { parseScopedName } from "@appstrate/core/naming";
import { computeIntegrity } from "@appstrate/core/integrity";
import { z } from "zod";
import { ApiError, forbidden, invalidRequest, notFound, validationFailed } from "../lib/errors.ts";
import { readJsonBody } from "@appstrate/core/request-body";
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
import {
  agentReadIsSummary,
  assertCatalogPackageAccess,
  assertDraftSelectorAllowed,
  assertPackageCopyAllowed,
  defaultDefinitionSelector,
  packageAccessSpaces,
  requireAgentRead,
} from "../lib/package-access.ts";
import {
  writeBundleToBuffer,
  parsePackageIdentity,
  type Bundle,
} from "@appstrate/afps-runtime/bundle";
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
 * `manifest.json` + `prompt.md`. Dependencies are a different surface: the
 * catalog puts a dependency's ENTIRE stored file map into the archive
 * (`DbPackageCatalog.fetch` extracts the whole published artifact — the same
 * catalog for a `?source=draft` export as for a published one, since only the
 * ROOT of a draft export is a working copy). A bundle carrying a skill
 * therefore hands out exactly the bytes
 * `GET /api/packages/{scope}/{name}/files[/content]` serves — and #1123/#1124
 * settled that those need `skills:read`, resolved per package TYPE rather than
 * one blanket scope. Without this guard the export is a looser door to the same
 * bytes: an `agents:read`-only credential is 403'd on the file explorer and
 * served the identical content here.
 *
 * Checked against the ASSEMBLED bundle, not the root manifest, so transitive
 * deps and any future widening of `depTypes` are covered by construction.
 *
 * Every dependency also needs live catalog reachability. This allows a readable
 * source in another accessible space while hiding packages confined to private
 * spaces.
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
    const parsed = parsePackageIdentity(identity);
    if (!parsed) throw invalidRequest(`Invalid package identity: ${identity}`);
    // The read scope is per TYPE, so it is proven once; reachability is per
    // PACKAGE and runs for every dependency. The scope comes first so a caller
    // holding none of it is told which permission it lacks rather than which
    // packages exist.
    if (!checked.has(type)) {
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
    await assertCatalogPackageAccess(c, parsed.packageId);
  }
}

export function createAgentsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/agents — list agents accessible to the current space
  router.get("/", requireAgentRead, async (c) => {
    const scope = getSpaceScope(c);
    const summaryOnly = agentReadIsSummary(c);

    // Single query: the activation rule (`activeHereSql` — placed here AND
    // switched on, or a system agent with no row) via LEFT JOIN. This page
    // answers "what can I launch here?", so every row on it is launchable;
    // an agent merely placed here, offered or switched off, lives on the
    // space library instead (`GET /api/spaces/{spaceId}/library`), which
    // carries its origin, its state and the switch.
    const [rows, runningCounts] = await Promise.all([
      listActivePackages(scope, "agent"),
      getRunningRunCounts(scope, runVisibilityFilter(c)),
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
        // `skills` and `mcp_servers` say what the agent is BUILT FROM — the
        // one thing in this list a summary read withholds. `integrations` says
        // which SaaS it talks to, which is what a launcher connects, so it
        // answers every caller. Everything else is how the launcher names and
        // picks an agent, which `agents:run` is entitled to.
        dependencies: {
          ...(summaryOnly
            ? {}
            : {
                skills: (manifest.dependencies?.skills ?? {}) as Record<string, string>,
                mcp_servers: (manifest.dependencies?.mcp_servers ?? {}) as Record<string, string>,
              }),
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
    requirePermission("agents", "configure"),
    requireAgent(),
    async (c) => {
      const scope = getSpaceScope(c);
      const loaded = c.get("package");
      // The manifest whose input schema these values must satisfy: the DRAFT
      // for an author who can write this agent — they are editing it — and the
      // latest published version for anybody else configuring an agent they
      // merely operate. The same selector the detail page rendered and the
      // readiness badge judged (`defaultDefinitionSelector`), so the editor
      // never validates against a definition the form did not show.
      const { selector: version } = await defaultDefinitionSelector(c, loaded);
      const { agent } = await resolveAgentRunVersion(loaded, version);
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

      await updateSpacePackage(scope, agent.id, {
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
  // Permission BEFORE `requireAgent()`, as on every agent route: that
  // middleware 404s on an unknown agent, so the reverse order answers "does
  // this agent exist?" to a caller that is not allowed to read agents at all —
  // 403-vs-404 enumerates the space's private catalog (#1341). The order is
  // enforced by `test/integration/middleware/agent-lookup-permission-order.test.ts`.
  router.get(
    `/${SCOPED_PACKAGE_ROUTE}/proxy`,
    requirePermission("agents", "read"),
    requireAgent(),
    async (c) => {
      const agent = c.get("package");
      const { proxyId } = await getSpacePackageSettings(getSpaceScope(c), agent.id);

      return c.json({ proxyId, resolved: proxyId !== "none" });
    },
  );

  // GET /api/agents/:scope/:name/connection-readiness — bulk integration
  // connection readiness for the agent: run-blocking CONNECTION verdict + the
  // per-integration management DTO.
  //
  // Same resolver, same pinned manifests as the run-kickoff 412 — but not the
  // whole kickoff gate: readiness also refuses an integration that is not
  // active in the space and excludes those ids from the resolver
  // (`skipIntegrationIds`). This endpoint runs no activation gate, so such
  // an integration surfaces here as a connection problem. Adding the skip alone
  // would make it worse (the item would drop out of `blocks_run` while the run
  // still refuses it); closing the gap means giving this DTO the activation
  // verdict too — a wire change to the Connexions tab. The kickoff remains the
  // authority; this is what the badge renders.
  // `rowAuthority()`: reporting on `?version=draft` is the author's view, gated
  // in the handler by the package's home space (`assertDraftSelectorAllowed`).
  router.get(
    `/${SCOPED_PACKAGE_ROUTE}/connection-readiness`,
    requirePermission("integrations", "read"),
    rowAuthority(),
    requireAgent(),
    async (c) => {
      const agent = c.get("package");
      // Resolved ONCE and handed to both: the gate and the default selector ask
      // the same question of the same package, and each one resolving the
      // caller's spaces for itself is two full space walks per badge.
      await assertDraftSelectorAllowed(c, agent.id, c.req.query("version"));
      return c.json(
        await resolveAgentConnectionReadiness({
          scope: getSpaceScope(c),
          agentPackageId: agent.id,
          actor: getActor(c),
          // Drives `can_add_connection`: the same exemption the connect route
          // applies, so the badge cannot promise what the mutation refuses.
          canConfigureIntegrations: c.get("permissions")?.has("integrations:configure") ?? false,
          // The ROUTER decides which definition readiness judges, and it is
          // EXACTLY the one the detail page rendered: an explicit selector (a
          // `draft` one only for a caller who may write the agent), else
          // `defaultDefinitionSelector`. Deriving it a second way is how the
          // badge came to 404 a page that had just rendered. The service takes
          // the answer and never re-derives it.
          version: c.req.query("version") || (await defaultDefinitionSelector(c, agent)).selector,
        }),
      );
    },
  );

  // PUT /api/agents/:scope/:name/proxy — set agent proxy override (admin-only)
  router.put(
    `/${SCOPED_PACKAGE_ROUTE}/proxy`,
    requirePermission("agents", "configure"),
    requireAgent(),
    async (c) => {
      const agent = c.get("package");
      const scope = getSpaceScope(c);
      const data = await readJsonBody(c, proxyIdSchema);

      await updateSpacePackage(scope, agent.id, { proxyId: data.proxyId });

      await recordAuditFromContext(c, {
        action: "agent.proxy_updated",
        resourceType: "agent",
        resourceId: agent.id,
        after: { proxyId: data.proxyId },
      });

      // Return the bare proxy-setting resource — same shape and read path
      // (`getSpacePackageSettings`) as GET /agents/:scope/:name/proxy (#657).
      const { proxyId } = await getSpacePackageSettings(scope, agent.id);
      return c.json({ proxyId, resolved: proxyId !== "none" });
    },
  );

  // GET /api/agents/:scope/:name/model — get agent model configuration.
  // `agents:run` opens it too: this is where the launch form reads the model a
  // run will resolve to, and the body carries no manifest and no prompt.
  router.get(`/${SCOPED_PACKAGE_ROUTE}/model`, requireAgentRead, requireAgent(), async (c) => {
    const agent = c.get("package");
    const { modelId, generationConfig } = await getSpacePackageSettings(getSpaceScope(c), agent.id);

    return c.json({ modelId, generation: generationConfig });
  });

  // PUT /api/agents/:scope/:name/model — set agent model override (admin-only)
  router.put(
    `/${SCOPED_PACKAGE_ROUTE}/model`,
    requirePermission("agents", "configure"),
    requireAgent(),
    async (c) => {
      const agent = c.get("package");
      const scope = getSpaceScope(c);
      const data = await readJsonBody(c, modelIdSchema);

      // Reject unknown/cross-org ids like run and schedule overrides do (#960); null clears.
      const current = await getSpacePackageSettings(scope, agent.id);
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

      await updateSpacePackage(scope, agent.id, {
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
      // (`getSpacePackageSettings`) as GET /agents/:scope/:name/model (#657).
      const { modelId, generationConfig } = await getSpacePackageSettings(scope, agent.id);
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
    requirePermission("persistence", "read"),
    requireAgent(),
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

      // Optional explicit scope override. `persistence:read` gates the route
      // and every role holds it, so the cross-actor view is gated on
      // `persistence:delete` instead — the admin-grade action of this family.
      // Everyone else stays narrowed to their own actor scope.
      const canReadEveryActor = c.get("permissions")?.has("persistence:delete") ?? false;

      const scopeOverride = canReadEveryActor
        ? scopeFromQueryParams(actorTypeParam, actorIdParam)
        : null;
      const scope = scopeOverride ?? callerScope;

      const wantsPinned = !kindParam || kindParam === "pinned";
      const wantsMemory = !kindParam || kindParam === "memory";
      if (kindParam && !wantsPinned && !wantsMemory) {
        throw invalidRequest("kind must be 'pinned' or 'memory'");
      }

      // A cross-actor reader inspecting at agent-level (no scope override, no
      // runId) sees every actor's pinned slots; everyone else is narrowed to
      // their scope.
      const pinnedScope = canReadEveryActor && !scopeOverride ? undefined : scope;

      const [pinned, memories] = await Promise.all([
        wantsPinned
          ? listPinnedSlots(agent.id, spaceId, pinnedScope, runIdParam)
          : Promise.resolve([]),
        wantsMemory ? listMemories(agent.id, spaceId, scope, runIdParam) : Promise.resolve([]),
      ]);

      // One resource, not a list: a snapshot of both halves under the SAME
      // actor-scope resolution, never paginated; `kind` narrows it.
      return c.json({
        object: "agent_persistence",
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
    requirePermission("persistence", "delete"),
    requireAgent(),
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
    requirePermission("persistence", "delete"),
    requireAgent(),
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
    requirePermission("persistence", "delete"),
    requireAgent(),
    async (c) => {
      const agent = c.get("package");
      const spaceId = c.get("spaceId");
      const kindParam = c.req.query("kind");
      const actorTypeParam = c.req.query("actor_type");
      const actorIdParam = c.req.query("actor_id");

      // Same actor-override guard the GET path applies: only a holder of
      // `persistence:delete` may target another actor's rows (or omit the
      // scope to bulk-wipe every actor). Everyone else is narrowed to their
      // own actor scope, so they cannot delete another actor's
      // memories/checkpoints by supplying an arbitrary actor_type / actor_id.
      const callerScope = scopeFromActor(getActor(c));
      const canTouchEveryActor = c.get("permissions")?.has("persistence:delete") ?? false;
      const scopeOverride = canTouchEveryActor
        ? scopeFromQueryParams(actorTypeParam, actorIdParam)
        : null;
      const scope = canTouchEveryActor ? (scopeOverride ?? undefined) : callerScope;

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
  // An EXECUTION door despite the verb: the bundle is what the CLI runs, so it
  // mounts `requireActiveAgent()` like the other two. That middleware is what
  // tells "not placed here" from "placed but switched off", which is the
  // distinction the CLI's run-by-id flow needs to prompt for an activation
  // rather than suggest a typo — and it lives there, once, so the three doors
  // answer this agent the same way.
  // `rowAuthority()`: past `agents:read` the handler refuses on the package
  // itself — the org's copy restriction (`assertPackageCopyAllowed`), draft
  // ownership (`assertDraftSelectorAllowed`) and a per-type read scope for
  // every dependency the assembled bundle carries.
  router.get(
    `/${SCOPED_PACKAGE_ROUTE}/bundle`,
    rateLimit(30),
    requirePermission("agents", "read"),
    rowAuthority(),
    requireAgent(),
    requireActiveAgent(),
    async (c) => {
      const scopeParam = c.req.param("scope")!;
      const nameParam = c.req.param("name")!;
      const packageId = `${scopeParam}/${nameParam}`;
      const orgId = c.get("orgId");
      const versionSpec = c.req.query("version") ?? null;
      const sourceQuery = c.req.query("source");
      // `source=draft` exports the agent's current draft state instead of a
      // published version, for the authors who own that working copy: the CLI
      // asks for it on an explicit `@draft` spec so a never-published agent can
      // still be run locally. Default stays `published`, which is what every
      // other caller — and every omitted selector — resolves to.
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

      const agent = c.get("package");
      // A bundle is the agent AND every transitive dependency's stored files in
      // one archive the caller walks away with — a COPY leaving the platform,
      // which is what `org_settings.restrict_package_copy` governs (RBAC spec
      // §6.10). Read + active is not enough: without this gate a restricted
      // organization's `download` refusal is one `--local` run away from being
      // pointless. Gated on the ROOT agent only (dependencies keep their own
      // read-scope gate below), with skills and system packages exempt inside
      // the helper. The consequence is deliberate: `appstrate run @scope/agent
      // --local` answers 403 `package_copy_restricted` there. A SERVER-side run
      // is unaffected; it assembles the same bundle without handing it over.
      const accessible = await packageAccessSpaces(c);
      const root = await assertCatalogPackageAccess(c, packageId);
      await assertPackageCopyAllowed(c, root, { orgId, accessible });
      // An EXPORTED draft is a draft run with the bytes handed over as well:
      // the archive carries the unpublished manifest and prompt, and `--local`
      // executes them on the caller's machine. Refusing `?version=draft` on the
      // run route while serving the same definition here would make that 403 a
      // formality, so the one predicate that says who owns a working copy
      // decides both (403 `draft_not_writable`). It gates the ROOT, which is
      // the only draft the archive carries: the closure resolves against
      // published versions (`buildBundleFromAgentDraft`), so no dependency's
      // working copy leaves by this door without its own `dependency_overrides`
      // gate.
      await assertDraftSelectorAllowed(c, packageId, useDraft ? "draft" : undefined);
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
          // With no `?version`, `resolveExportVersion` falls back to the
          // `latest` dist-tag and raises the GENERIC `not_found` when nothing
          // is published — on the wire indistinguishable from "no such agent",
          // so the CLI tells the user to check their spelling for an agent that
          // exists and has merely never been released. Re-raise it as the code
          // the other execution doors already publish for exactly this
          // condition (`services/agent-version-resolver.ts`). An EXPLICIT
          // `?version` keeps its own 404: there the spec really does name a
          // version that does not resolve.
          try {
            versionLabel = await resolveExportVersion(agent.id, versionSpec);
          } catch (err) {
            if (!versionSpec && err instanceof ApiError && err.status === 404) {
              throw new ApiError({
                status: 404,
                code: "no_published_version",
                title: "No Published Version",
                detail: `Agent '${agent.id}' has no published version — publish one, or export the working copy with ?source=draft`,
              });
            }
            throw err;
          }
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
