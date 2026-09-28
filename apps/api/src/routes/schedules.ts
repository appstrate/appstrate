// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  assertDependencyOverrideKeysDeclared,
  connectionOverridesSchema,
  dependencyOverridesSchema,
} from "../lib/launch-schemas.ts";
import {
  modelGenerationSettingsSchema,
  reconcileModelGenerationSettings,
} from "@appstrate/core/model-generation";
import type { AppEnv } from "../types/index.ts";
import {
  getSchedule,
  listSchedules,
  listPackageSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
} from "../services/scheduler.ts";
import { computeNextRun, isValidCron } from "../lib/cron.ts";
import { requireActiveAgent, requireAgent } from "../middleware/guards.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { ApiError, invalidRequest, notFound, validationFailed } from "../lib/errors.ts";
import { readJsonBody } from "@appstrate/core/request-body";
import type { AuditPayload } from "@appstrate/core/module";
import { parseListPagination } from "../lib/list-query.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { getActor, actorFromIds, type Actor } from "../lib/actor.ts";
import { getSpaceScope, type SpaceScope } from "../lib/scope.ts";
import { getOrgMember } from "../services/organizations.ts";
import { getEndUser } from "../services/end-users.ts";
import {
  assertExplicitModelExists,
  resolveModel,
  validateGenerationOverride,
} from "../services/org-models.ts";
import { getSpacePackageSettings, type SpacePackageSettings } from "../services/space-packages.ts";
import { resolveAndValidateScheduleInput } from "../services/input-resolution.ts";
import { getPackage } from "../services/package-catalog.ts";
import { resolveAgentRunVersion } from "../services/agent-version-resolver.ts";
import type { LoadedPackage } from "../types/index.ts";
import { asJSONSchemaObject, schemaHasFileFields } from "@appstrate/core/form";
import {
  agentReadIsSummary,
  assertDraftSelectorAllowed,
  assertDependencyDraftOverridesAllowed,
} from "../lib/package-access.ts";
import { listScheduleRuns } from "../services/state/runs.ts";
import { requireRunsRead, runVisibilityFilter } from "../lib/run-visibility.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import { setOffsetLinkHeader } from "../lib/pagination-link.ts";
import { listResponse } from "../lib/list-response.ts";
import { scheduleInputSchema } from "../lib/jsonb-schemas.ts";
import { SCOPED_PACKAGE_ROUTE } from "./scoped-package-route.ts";

// Both maps are the shared launch rules (`lib/launch-schemas.ts`). A schedule
// freezes them onto the row and replays them on every tick, which is what makes
// a second, drifting copy expensive here: the write answers 200 once and every
// subsequent fire is silently wrong.

/**
 * The 400 a schedule's stored input earns when it no longer satisfies the
 * agent's schema. One shape for the create route and the update route, so the
 * two cannot answer the same bad body differently.
 */
function scheduleInputInvalid(errors: { field: string; message: string }[]): ApiError {
  return validationFailed(
    errors.map((e) => ({
      field: e.field ? `input.${e.field}` : "input",
      code: "invalid_input",
      title: "Invalid Input",
      message: e.message,
    })),
  );
}

/**
 * Refuse a cron/timezone pair the scheduler could never turn into a fire.
 *
 * `timezone` used to be a bare `z.string()` next to an `isValidCron`-gated
 * `cron_expression`, and an unknown zone is silent all the way down:
 * `CronExpressionParser.parse(expr, { tz })` accepts it and only `.next()`
 * throws, which `computeNextRun` swallows into `null` (row written with
 * `next_run_at = NULL`) and BullMQ's `getNextMillis` swallows into `undefined`
 * (no repeat job registered at all). The API answered `201 { enabled: true }`
 * for a schedule that would never run — no log line, no failed run, no
 * `failSchedule`.
 *
 * The gate is `computeNextRun` ITSELF rather than a zone allowlist
 * (`Intl.supportedValuesOf("timeZone")`) or a `new Intl.DateTimeFormat` probe.
 * An allowlist is a second source of truth that can disagree with the parser
 * — it already does, on the offset and `Etc/*` forms cron-parser accepts —
 * whereas this runs the exact function `createSchedule` / `updateSchedule`
 * call to fill `next_run_at`, over the same `cron-parser` version BullMQ
 * resolves for `getNextMillis`. Whatever this accepts therefore produces a
 * real `next_run_at` AND a registered repeat job, by construction.
 *
 * The cron check stays separate so a bad expression keeps blaming
 * `cron_expression`; past it, a `null` can only come from the zone.
 */
function assertFirable(cronExpression: string, timezone: string): void {
  if (!isValidCron(cronExpression)) {
    throw invalidRequest("Invalid cron expression", "cron_expression");
  }
  if (computeNextRun(cronExpression, timezone) === null) {
    throw invalidRequest(`Invalid timezone '${timezone}'`, "timezone");
  }
}

/**
 * Did this patch MOVE the draft selector, or merely echo the one already
 * stored?
 *
 * A stored value is not an act. The edit form reads the row, renders it, and
 * posts every field back, so `version_override: "draft"` arrives on a patch
 * whose author only touched the cron expression — and judging the echo refuses
 * that cron edit to every space member who did not write the AGENT, for a
 * working copy the request never asked to run. The row's selector was judged
 * when it was written, by whoever wrote it; re-deciding it on each subsequent
 * write would make authority a property of the last editor rather than of the
 * one who chose the draft.
 *
 * Only a value the patch CHANGES is a decision, and then the value judged is
 * the new one. Clearing it (`null`) is never refused: dropping back to the
 * published default takes nothing away from anyone.
 */
function draftSelectorMoved(patched: string | null | undefined, stored: string | null): boolean {
  if (patched === undefined) return false;
  return (patched ?? undefined) !== (stored ?? undefined);
}

/**
 * The same question, per dependency: the subset of `dependency_overrides` this
 * patch actually MOVES.
 *
 * Judged key by key rather than map by map, because the map is judged key by
 * key — authority over `@a/skill`'s draft says nothing about `@b/skill`'s — and
 * because the form posts the whole map back. A key whose value is unchanged was
 * already proven at the write that introduced it; a key this patch DROPS takes
 * a draft away, which needs no authority at all.
 *
 * AUTHORITY ONLY. Whether a key names a declared dependency at all is a
 * property of the map and the EFFECTIVE manifest together, and `version_override`
 * moves that manifest under a map nothing touched — so the form half is gated
 * on the pair, not on this delta. Do not re-attach it here.
 */
function movedDependencyOverrides(
  patched: Readonly<Record<string, string>> | null | undefined,
  stored: Readonly<Record<string, string>> | null,
): Record<string, string> | null {
  if (!patched) return null;
  const moved: Record<string, string> = {};
  for (const [dependencyId, selector] of Object.entries(patched)) {
    if (stored?.[dependencyId] !== selector) moved[dependencyId] = selector;
  }
  return moved;
}

/**
 * Validate a schedule's stored input against the manifest the schedule will
 * actually FIRE — not the editor's working copy.
 *
 * `getPackage()` returns `packages.draft_manifest`, but the fire path resolves
 * `version_override` through `resolveAgentRunVersion` (`services/scheduler.ts`),
 * and with no override that selector means the PUBLISHED version, never the
 * draft. Validating the draft here judged a definition the schedule will never
 * execute, and every disagreement between the two became a `201` followed by a
 * permanent, silent failure at every tick:
 *
 *  - a published schema requiring a field the draft dropped → accepted, then
 *    `failSchedule` on every fire;
 *  - an agent with NO published version → accepted, then a 404
 *    `no_published_version` on every fire (while `POST …/run` correctly 404s
 *    at the call);
 *  - the file-input refusal below — the whole reason this check exists — read
 *    a manifest that never runs, so an agent whose PUBLISHED schema has a file
 *    field was schedulable.
 *
 * Resolving first is what `routes/runs.ts` already does for a manual launch;
 * this is the same order on the surface that keeps its verdict forever.
 *
 * Authority over the DRAFT is decided by the caller, not here: create judges
 * the selector it receives, update judges only one that MOVES
 * ({@link draftSelectorMoved}). Both do it at the WRITE and never at fire time
 * — the authority is a property of the principal who writes the row, frozen
 * onto it exactly as `connection_overrides` are, and `services/scheduler.ts`
 * runs with no Hono context and deliberately re-checks nothing. This function
 * still RESOLVES the selector it is handed, including a `draft` it did not
 * judge, because the input has to be validated against the manifest that will
 * actually fire.
 */
async function assertScheduleTargetValid(args: {
  c: Context<AppEnv>;
  scope: SpaceScope;
  agent: LoadedPackage;
  /** `version_override` as this request leaves it — the selector every fire replays. */
  versionOverride: string | undefined;
  packageSettings: SpacePackageSettings;
  input: Record<string, unknown> | undefined;
}): Promise<LoadedPackage> {
  const { agent: effectiveAgent } = await resolveAgentRunVersion(args.agent, args.versionOverride);
  const inputSchema = effectiveAgent.manifest.input?.schema;

  if (schemaHasFileFields(inputSchema ? asJSONSchemaObject(inputSchema) : undefined)) {
    throw invalidRequest("Cannot schedule agents with file inputs");
  }

  // The author defaults and the editor's stored values sit UNDER the
  // schedule's own frozen values, so a required field the editor already
  // answers must not be demanded again here. A schedule value naming a locked
  // field is refused (400 `locked_input_field`) at this write rather than
  // silently each tick.
  const resolution = resolveAndValidateScheduleInput({
    inputSchema,
    editorDefaults: args.packageSettings.values,
    lockedFields: args.packageSettings.locked,
    input: args.input,
  });
  if (resolution.errors) throw scheduleInputInvalid(resolution.errors);
  // Handed back so the dependency gate judges override KEYS against the very
  // definition this write just validated the input against — resolving the
  // selector a second time there would let the two answers drift.
  return effectiveAgent;
}

/**
 * Load a schedule in the caller's scope, or 404 with the message the three
 * `/schedules/:id` routes have always answered.
 *
 * The row is rendered for the CALLER: `unread_count` against their recipient
 * tuple, `running_runs` and `last_run_number` against the runs they may read.
 * The two write routes use it as an existence check and discard those counters,
 * so the caller's scoping is the one rule here rather than a per-route choice.
 */
async function loadScheduleOr404(c: Context<AppEnv>, id: string, scope: SpaceScope) {
  const schedule = await getSchedule(id, scope, getActor(c), runVisibilityFilter(c));
  if (!schedule) {
    throw notFound(`Schedule '${id}' not found`);
  }
  return schedule;
}

// #738: schedule execution identity, chosen by an admin from the form.
// XOR — exactly one of userId / endUserId. Omitted at create → defaults to
// the caller (`getActor`). Omitted at update → actor left untouched. The actor
// can never be cleared (preserves #735: a schedule always has an identity).
// `strictObject` BEFORE `.refine()` — `.refine()` returns a ZodPipe on which
// `.strict()` is no longer chainable, and the enclosing bodies' own `.strict()`
// only closes their ROOT. Without it, `{ actor: { userId, endUserIds } }`
// strips the typo, the XOR below counts exactly one key and the schedule is
// frozen onto the WRONG identity with a 201 as the only receipt — the very
// failure {@link createScheduleSchema}'s docstring closes the root against.
const actorSchema = z
  .strictObject({
    userId: z.string().min(1).optional(),
    endUserId: z.string().min(1).optional(),
  })
  .refine((a) => (a.userId ? 1 : 0) + (a.endUserId ? 1 : 0) === 1, {
    message: "provide exactly one of userId or endUserId",
  });

/**
 * Resolves + validates a selected schedule actor against the org/space scope.
 * Validates org membership (user) or space ownership (end-user) so a schedule
 * can never be pinned to an identity outside the caller's tenant. Returns
 * `fallback` when no actor was selected (the create-route default).
 */
async function resolveScheduleActor(
  scope: SpaceScope,
  selected: { userId?: string; endUserId?: string } | undefined,
  fallback?: Actor,
): Promise<Actor> {
  if (!selected || (!selected.userId && !selected.endUserId)) {
    if (fallback) return fallback;
    throw invalidRequest("actor.userId or actor.endUserId is required", "actor");
  }
  if (selected.userId && selected.endUserId) {
    throw invalidRequest("actor.userId and actor.endUserId are mutually exclusive", "actor");
  }
  if (selected.userId) {
    const member = await getOrgMember(scope.orgId, selected.userId);
    if (!member) {
      throw invalidRequest("actor.userId is not a member of this organization", "actor.userId");
    }
    return { type: "user", id: selected.userId };
  }
  // endUserId present. Translate getEndUser's 404 into a 400 so both actor
  // branches report an invalid selection consistently as a bad request.
  try {
    await getEndUser(scope, selected.endUserId!);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw invalidRequest("actor.endUserId is not an end-user of this space", "actor.endUserId");
    }
    throw err;
  }
  return { type: "end_user", id: selected.endUserId! };
}

/**
 * `.strict()` (#1187's rule, extended to this surface): an unknown field is a
 * 400, never a silent drop. A schedule is the strongest case for it — the other
 * launch surfaces mis-execute ONE run, whereas a schedule freezes exactly these
 * fields onto `package_schedules` and replays them on every fire, so a stripped
 * field is a wrong run forever with a 201 as the only receipt.
 */
export const createScheduleSchema = z
  .object({
    name: z.string().optional(),
    cron_expression: z.string().min(1, "cron_expression is required"),
    timezone: z.string().default("UTC"),
    input: scheduleInputSchema.default({}),
    model_id_override: z.string().optional(),
    generation_config_override: modelGenerationSettingsSchema.optional(),
    proxy_id_override: z.string().optional(),
    version_override: z.string().optional(),
    connection_overrides: connectionOverridesSchema.optional(),
    dependency_overrides: dependencyOverridesSchema.optional(),
    actor: actorSchema.optional(),
  })
  .strict();

/** `.strict()` for the same reason as {@link createScheduleSchema}. */
export const updateScheduleSchema = z
  .object({
    name: z.string().optional(),
    cron_expression: z.string().optional(),
    timezone: z.string().optional(),
    input: scheduleInputSchema.optional(),
    enabled: z.boolean().optional(),
    // `null` clears the override; omitted leaves it untouched.
    model_id_override: z.string().nullable().optional(),
    generation_config_override: modelGenerationSettingsSchema.nullable().optional(),
    proxy_id_override: z.string().nullable().optional(),
    version_override: z.string().nullable().optional(),
    connection_overrides: connectionOverridesSchema.nullable().optional(),
    dependency_overrides: dependencyOverridesSchema.nullable().optional(),
    // No `.nullable()` — the actor can be re-pointed but never cleared (#735).
    actor: actorSchema.optional(),
  })
  .strict();

export function createSchedulesRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/schedules — list all schedules (space-scoped)
  router.get("/schedules", requirePermission("schedules", "read"), async (c) => {
    const scope = getSpaceScope(c);
    // The caller is the VIEWER of the run counters (`unread_count` is
    // recipient-scoped), never the schedules' own execution actor.
    const schedules = await listSchedules(scope, getActor(c), runVisibilityFilter(c));
    return c.json(listResponse(schedules));
  });

  // GET /api/agents/:scope/:name/schedules — list schedules for an agent
  router.get(
    `/agents/${SCOPED_PACKAGE_ROUTE}/schedules`,
    requirePermission("schedules", "read"),
    requireAgent(),
    async (c) => {
      const scope = getSpaceScope(c);
      const agent = c.get("package");
      const schedules = await listPackageSchedules(
        scope,
        agent.id,
        getActor(c),
        runVisibilityFilter(c),
      );
      return c.json(listResponse(schedules));
    },
  );

  // POST /api/agents/:scope/:name/schedules — create a schedule
  // A schedule pinned to `draft` — or carrying a draft
  // dependency override — is an author's act, judged in the handler against the
  // package's home space (`403 draft_not_writable`).
  router.post(
    `/agents/${SCOPED_PACKAGE_ROUTE}/schedules`,
    rateLimit(10),
    requirePermission("schedules", "write"),
    requireAgent(),
    // Arming a schedule is an execution decision, so it asks the execution
    // question now rather than leaving the first tick to discover it. LISTING
    // the schedules of a switched-off agent is a read and does not.
    requireActiveAgent(),
    async (c) => {
      const agent = c.get("package");

      const data = await readJsonBody(c, createScheduleSchema);

      // Request-local refusals first — no lookup needed to answer them.
      assertFirable(data.cron_expression, data.timezone);

      const scope = getSpaceScope(c);

      const packageSettings = await getSpacePackageSettings(scope, agent.id);
      // A creation names every selector it carries, so every one of them is an
      // act: `version_override: "draft"` here IS the request to freeze the
      // author's working copy onto a row that replays it forever.
      await assertDraftSelectorAllowed(c, agent.id, data.version_override);
      const effectiveAgent = await assertScheduleTargetValid({
        c,
        scope,
        agent,
        versionOverride: data.version_override,
        packageSettings,
        input: data.input,
      });
      // The same proof for every dependency the schedule opts into its working
      // copy — frozen onto the row here, replayed unchecked at every fire. A
      // key the effective manifest does not declare is refused here as a
      // malformed request, rather than freezing onto the row and 400-ing at
      // every tick.
      await assertDependencyDraftOverridesAllowed(
        c,
        data.dependency_overrides,
        effectiveAgent.manifest as unknown as Record<string, unknown>,
      );

      // #738: actor defaults to the caller; an admin may override it from the
      // form (validated against this org/space scope).
      const actor = await resolveScheduleActor(scope, data.actor, getActor(c));

      // Reject a `model_id_override` that references no real model up front, so
      // a bad id fails at schedule-create time instead of silently each tick.
      const explicitModel = await assertExplicitModelExists(scope.orgId, data.model_id_override);
      let generationConfigOverride = data.generation_config_override;
      if (generationConfigOverride && Object.keys(generationConfigOverride).length > 0) {
        const selectedModel =
          explicitModel ??
          (await resolveModel(
            scope.orgId,
            agent.id,
            data.model_id_override ?? packageSettings.modelId,
          ));
        generationConfigOverride = validateGenerationOverride(
          generationConfigOverride,
          selectedModel,
          "generation_config_override",
        );
      }

      const schedule = await createSchedule(scope, agent.id, actor, {
        name: data.name,
        cronExpression: data.cron_expression,
        timezone: data.timezone,
        input: data.input,
        modelIdOverride: data.model_id_override ?? null,
        generationConfigOverride: generationConfigOverride ?? null,
        proxyIdOverride: data.proxy_id_override ?? null,
        versionOverride: data.version_override ?? null,
        connectionOverrides: data.connection_overrides ?? null,
        dependencyOverrides: data.dependency_overrides ?? null,
      });
      await recordAuditFromContext(c, {
        action: "schedule.created",
        resourceType: "schedule",
        resourceId: schedule.id,
        after: {
          packageId: agent.id,
          cronExpression: data.cron_expression,
          timezone: data.timezone,
          actorType: actor.type,
          actorId: actor.id,
        },
      });
      return c.json(schedule, 201);
    },
  );

  // GET /api/schedules/:id — get a single schedule
  router.get("/schedules/:id", requirePermission("schedules", "read"), async (c) => {
    const id = c.req.param("id")!;
    const schedule = await loadScheduleOr404(c, id, getSpaceScope(c));
    return c.json(schedule);
  });

  // PATCH /api/schedules/:id — merge-update a schedule (RFC 7396)
  // Same draft authority as the create route, asked of the package the stored
  // schedule points at.
  router.patch("/schedules/:id", requirePermission("schedules", "write"), async (c) => {
    const id = c.req.param("id")!;
    const scope = getSpaceScope(c);
    const existing = await loadScheduleOr404(c, id, scope);

    const data = await readJsonBody(c, updateScheduleSchema);

    // Only when this patch touches either half: an unrelated patch (say
    // `{enabled:false}`) on a row written before this gate existed must stay
    // applicable. `updateSchedule` recomputes `next_run_at` from the EFFECTIVE
    // pair, so that is the pair checked here — same `??` fallbacks, same
    // "UTC" default.
    if (data.cron_expression !== undefined || data.timezone !== undefined) {
      assertFirable(
        data.cron_expression ?? existing.cron_expression,
        data.timezone ?? existing.timezone ?? "UTC",
      );
    }

    // The agent's per-space settings — read once and shared by the
    // locked-field refusal and the generation-config reconciliation below,
    // which can both run on the same request.
    const packageSettings = await getSpacePackageSettings(scope, existing.packageId);

    // The selector this row will replay after the patch: `null` clears the
    // override, i.e. back to the unified default; omitted leaves whatever the
    // row already holds. Every judgement below is made against THIS value.
    const nextVersionOverride =
      (data.version_override !== undefined ? data.version_override : existing.version_override) ??
      undefined;
    /** Set by the input gate below when it runs; reused by the dependency gate. */
    let effectiveAgent: LoadedPackage | null = null;

    // A `version_override` this patch MOVES is an act and proves itself; one it
    // merely echoes back was judged at the write that chose it. Outside the
    // input gate on purpose: that gate asks "does the manifest decision move",
    // and a selector that moves always does, while a patch that only re-sends
    // it must reach the input validation without being refused.
    if (draftSelectorMoved(data.version_override, existing.version_override)) {
      await assertDraftSelectorAllowed(c, existing.packageId, data.version_override);
    }

    // Same resolve-and-validate the create route runs, for the same stated
    // reason: refuse at THIS write rather than silently at every tick. A PATCH
    // replacing `input` with a wrong-typed or incomplete value used to answer
    // 200 and then die on every subsequent fire, visible only in the
    // schedule's failure record.
    //
    // Gated on the patch actually MOVING the manifest decision, which is
    // exactly `input` and `version_override` — the only two request fields
    // `assertScheduleTargetValid` reads (its other two arguments, the agent
    // and the space-level `packageSettings`, are not patchable from here). Run
    // unconditionally, it also judged patches that cannot invalidate anything,
    // and its resolve step 404s `no_published_version` on an agent that has
    // never been published. Schedules on such agents exist — POST accepted
    // them before this gate — so `{"enabled": false}` on one answered 404 and
    // an operator could no longer disable a misfiring legacy schedule, only
    // delete it. A patch that merely REDUCES what the row does must always be
    // applicable; one that changes what it fires is what has to prove itself.
    //
    // `data.input ?? existing.input` because a patch that moves only
    // `version_override` must still be checked against the input the row will
    // keep replaying (and vice versa) — the pair is validated together, the
    // gate only decides whether to look at all.
    if (data.input !== undefined || data.version_override !== undefined) {
      const agentForInput = await getPackage(existing.packageId, scope.orgId);
      // `package_schedules.package_id` is `ON DELETE CASCADE` and `getPackage`
      // admits system packages, so this is unreachable in practice — it exists
      // so the impossible case is a typed 404 rather than a schedule validated
      // against nothing.
      if (!agentForInput) throw notFound(`Agent '${existing.packageId}' not found`);
      effectiveAgent = await assertScheduleTargetValid({
        c,
        scope,
        agent: agentForInput,
        // `null` clears the override, i.e. back to the unified default; omitted
        // leaves whatever the row already replays.
        versionOverride: nextVersionOverride,
        packageSettings,
        input: data.input ?? existing.input ?? undefined,
      });
    }

    // `dependency_overrides` is judged in two halves, and they do NOT share a
    // trigger.
    //
    // FORM — "does this key name a dependency the manifest declares?" — is a
    // property of the (map, effective manifest) PAIR, and `version_override`
    // moves the manifest. A patch sending `{version_override:"draft"}` alone
    // re-points the row at a definition that may no longer declare the skill
    // the stored map pins, so the map has to be re-judged against the new
    // target even though not one of its entries moved. Gated on `movedDeps`
    // it was not: the row answered 200 and then 400-ed in
    // `freezeRunSpawnDependencies` at every tick, forever, exactly the silent
    // permanent failure `assertScheduleTargetValid` exists to prevent. So the
    // form half runs whenever EITHER half of the pair moves, over the WHOLE
    // effective map — the one the row will replay, not the patch's delta.
    //
    // AUTHORITY — "may I pin `draft` on that package?" — stays on the moving
    // entries only, judged package by package by `movedDependencyOverrides`:
    // re-sending a stored selector is not asking for it again, and a key this
    // patch DROPS takes a draft away.
    const effectiveDependencyOverrides =
      data.dependency_overrides !== undefined
        ? data.dependency_overrides
        : existing.dependency_overrides;
    const movedDeps = movedDependencyOverrides(
      data.dependency_overrides,
      existing.dependency_overrides,
    );
    if (
      (data.version_override !== undefined || data.dependency_overrides !== undefined) &&
      effectiveDependencyOverrides &&
      Object.keys(effectiveDependencyOverrides).length > 0
    ) {
      // The manifest the keys are judged against is the one this row will
      // FIRE, so a patch that only moves the dependency map still resolves it —
      // adding an override changes what the schedule executes, and that is the
      // half of a patch that has to prove itself. Already resolved above
      // whenever `version_override` is part of the patch (same condition gates
      // the input pair), so this second lookup only happens for a patch that
      // touches the map alone.
      let target = effectiveAgent;
      if (!target) {
        const agentForDeps = await getPackage(existing.packageId, scope.orgId);
        // Unreachable in practice for the same reason the input gate's twin is:
        // `package_schedules.package_id` cascades. Typed, not assumed.
        if (!agentForDeps) throw notFound(`Agent '${existing.packageId}' not found`);
        target = (await resolveAgentRunVersion(agentForDeps, nextVersionOverride)).agent;
      }
      const targetManifest = target.manifest as unknown as Record<string, unknown>;
      assertDependencyOverrideKeysDeclared(targetManifest, effectiveDependencyOverrides);
      if (movedDeps && Object.keys(movedDeps).length > 0) {
        // Re-runs the key gate over the moving subset — a subset of the map
        // just cleared, so it can only pass. Kept whole rather than reaching
        // for `assertDraftSelectorAllowed` directly: the form-before-authority
        // ordering is stated inside that helper and no caller should be able
        // to order the two wrong.
        await assertDependencyDraftOverridesAllowed(c, movedDeps, targetManifest);
      }
    }

    // Reject a `model_id_override` that references no real model (no-op when
    // the field isn't part of this patch).
    const explicitModel = await assertExplicitModelExists(scope.orgId, data.model_id_override);
    let generationConfigOverride = data.generation_config_override;
    if (
      (generationConfigOverride && Object.keys(generationConfigOverride).length > 0) ||
      (generationConfigOverride === undefined &&
        data.model_id_override !== undefined &&
        existing.generation_config_override)
    ) {
      const effectiveModelOverride =
        data.model_id_override !== undefined ? data.model_id_override : existing.model_id_override;
      const selectedModel =
        explicitModel ??
        (await resolveModel(
          scope.orgId,
          existing.packageId,
          effectiveModelOverride ?? packageSettings.modelId,
        ));

      if (generationConfigOverride && Object.keys(generationConfigOverride).length > 0) {
        generationConfigOverride = validateGenerationOverride(
          generationConfigOverride,
          selectedModel,
          "generation_config_override",
        );
      } else if (existing.generation_config_override) {
        generationConfigOverride = reconcileModelGenerationSettings(
          existing.generation_config_override,
          selectedModel?.generation,
        );
      }
    }

    // #738: re-point the actor when the caller selected one (validated against
    // this org/space scope). `undefined` leaves the existing actor untouched.
    const actor = data.actor ? await resolveScheduleActor(scope, data.actor) : undefined;

    // Only a *real* identity change invalidates frozen connection picks. Picking
    // the same actor (or omitting it) leaves overrides untouched.
    const existingActor = actorFromIds(existing.userId, existing.endUserId);
    const actorChanged =
      !!actor &&
      (!existingActor || actor.type !== existingActor.type || actor.id !== existingActor.id);

    // On a real change, frozen `connection_overrides` reference the previous
    // identity's connections — reset them unless this patch supplies fresh
    // picks, forcing a re-pick under the new identity.
    const connectionOverrides =
      actorChanged && data.connection_overrides === undefined ? null : data.connection_overrides;

    // Translate snake_case wire fields to internal camelCase for the service.
    const schedule = await updateSchedule(
      scope,
      id,
      {
        name: data.name,
        cronExpression: data.cron_expression,
        timezone: data.timezone,
        input: data.input,
        enabled: data.enabled,
        modelIdOverride: data.model_id_override,
        generationConfigOverride,
        proxyIdOverride: data.proxy_id_override,
        versionOverride: data.version_override,
        connectionOverrides,
        dependencyOverrides: data.dependency_overrides,
        actor,
      },
      // `actor` above is the schedule's (possibly re-pointed) execution
      // identity; the run counters in the response belong to whoever is
      // looking at it.
      getActor(c),
      runVisibilityFilter(c),
    );
    // Mirror schedule.created: explicit camelCase keys (dominant audit
    // convention — see api-keys.ts, modules/webhooks/routes.ts). Only
    // include keys the caller actually sent so the audit reflects the
    // patch, not a snapshot of the whole row.
    const auditAfter: AuditPayload = {};
    if (data.name !== undefined) auditAfter.name = data.name;
    if (data.cron_expression !== undefined) auditAfter.cronExpression = data.cron_expression;
    if (data.timezone !== undefined) auditAfter.timezone = data.timezone;
    if (data.input !== undefined) auditAfter.input = data.input;
    if (data.enabled !== undefined) auditAfter.enabled = data.enabled;
    if (data.model_id_override !== undefined) auditAfter.modelIdOverride = data.model_id_override;
    if (generationConfigOverride !== undefined)
      auditAfter.generationConfigOverride = generationConfigOverride;
    if (data.proxy_id_override !== undefined) auditAfter.proxyIdOverride = data.proxy_id_override;
    if (data.version_override !== undefined) auditAfter.versionOverride = data.version_override;
    if (data.connection_overrides !== undefined)
      auditAfter.connectionOverrides = data.connection_overrides;
    if (data.dependency_overrides !== undefined)
      auditAfter.dependencyOverrides = data.dependency_overrides;
    if (actor) {
      auditAfter.actorType = actor.type;
      auditAfter.actorId = actor.id;
    }
    await recordAuditFromContext(c, {
      action: "schedule.updated",
      resourceType: "schedule",
      resourceId: id,
      after: auditAfter,
    });
    return c.json(schedule);
  });

  // DELETE /api/schedules/:id — delete a schedule
  router.delete("/schedules/:id", requirePermission("schedules", "delete"), async (c) => {
    const id = c.req.param("id")!;
    const scope = getSpaceScope(c);
    await loadScheduleOr404(c, id, scope);
    await deleteSchedule(scope, id);
    await recordAuditFromContext(c, {
      action: "schedule.deleted",
      resourceType: "schedule",
      resourceId: id,
    });
    return c.body(null, 204);
  });

  // GET /api/schedules/:id/runs — list runs for a schedule
  // Two permissions, because the response is two resources: the schedule
  // names the rows, but every field of them is a run. `schedules:read` alone
  // is a legal, grantable scope set, so without the run gate a credential with
  // no run permission at all reads the full enriched run projection — input,
  // result, checkpoint, error, context snapshot, cost.
  router.get(
    "/schedules/:id/runs",
    requirePermission("schedules", "read"),
    requireRunsRead,
    async (c) => {
      const scheduleId = c.req.param("id")!;
      const scope = getSpaceScope(c);
      const { limit, offset } = parseListPagination(c, { defaultLimit: 20 });
      // `schedules:read` is space-wide, so the schedule itself is readable to
      // every member — but its RUNS are runs, and follow the run predicate:
      // without `runs:read-all` a colleague's schedule lists nothing.
      const result = await listScheduleRuns(scope, scheduleId, {
        limit,
        offset,
        actor: getActor(c),
        visibility: runVisibilityFilter(c),
        canReadAgentInput: !agentReadIsSummary(c),
      });
      setOffsetLinkHeader({ c, limit, offset, total: result.total });
      return c.json(result);
    },
  );

  return router;
}
