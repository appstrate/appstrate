// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AgentManifest, AppEnv } from "../types/index.ts";
import type { AgentDetail } from "@appstrate/shared-types";
import {
  getPackage,
  getPackageForRead,
  resolveDeclaredSkills,
} from "../services/package-catalog.ts";
import {
  resolveAgentRunVersion,
  VERSION_SELECTOR_DRAFT,
} from "../services/agent-version-resolver.ts";
import { getOrgItem } from "../services/package-items/crud.ts";
import { CONFIG_BY_TYPE } from "../services/package-items/config.ts";
import {
  getVersionCount,
  getLatestVersionCreatedAt,
  computeHasUnpublishedChanges,
} from "../services/package-versions.ts";
import { getLastRun, getRunningRunsForPackage } from "../services/state/runs.ts";
import { getSpacePackageSettings, hasPackageAccess } from "../services/space-packages.ts";
import { resolveRunTimeout } from "../services/run-limits.ts";
import { isToolsWildcard, parseManifestIntegrations } from "@appstrate/core/dependencies";
import { withoutLockedFields } from "@appstrate/core/input-resolution";
import { parseScopedName } from "@appstrate/core/naming";
import { getItemId } from "./packages.ts";
import { notFound } from "../lib/errors.ts";
import { getSpaceScope } from "../lib/scope.ts";
import {
  agentReadIsSummary,
  draftNotWritable,
  defaultDefinitionSelector,
  homeWireForCaller,
  homeWritableForPackages,
  packageAccessSpaces,
} from "../lib/package-access.ts";
import { runVisibilityFilter } from "../lib/run-visibility.ts";

/**
 * The agent's dependency groups, split by who is entitled to them.
 *
 * `integrations` — which SaaS the agent talks to — answers EVERY caller. A
 * runner holds `integrations:read`/`connect`/`disconnect` precisely so it can
 * hook its own accounts up to the agents it launches, and the run preflight
 * already names the missing ids back to it (`connection_missing`). `skills` and
 * `mcp_servers` are the composition — what the agent is built FROM — so a
 * summary read omits them, and with them the skills catalog lookup, a scope an
 * `agents:run`-only caller does not hold. An omitted group is absent, never an
 * empty array: `skills: []` would say the agent declares none, which is false.
 *
 * Both skill branches project off the EFFECTIVE manifest, never off the package
 * object (#878), but they expose different sets: a versioned detail lists every
 * DECLARED skill (bare id + range, straight from the manifest — no catalog
 * read) so the dependency-override UI can offer a pin for one that is missing,
 * while the draft detail lists only skills the org catalog resolves, enriched
 * with display metadata. `use-agent-readiness.ts` mirrors the server's
 * missing-skill check against the draft array, so widening it here would
 * silently stop the client flagging a missing skill. Unifying the two — one
 * array of declared skills carrying `resolved` — is a wire change, tracked
 * separately.
 *
 * Every skill carries `home_writable`: the launch form offers "run this
 * dependency's draft" per skill, and the run route refuses that draft to
 * whoever cannot write THAT skill. Without the flag the option is a button that
 * 403s. One catalogue read for the whole list, never one per row.
 */
async function buildDependencyGroups(
  m: AgentManifest,
  orgId: string,
  opts: {
    versioned: boolean;
    summaryOnly: boolean;
    c: Context<AppEnv>;
    accessible: Awaited<ReturnType<typeof packageAccessSpaces>>;
  },
): Promise<AgentDetail["dependencies"]> {
  const integrations = parseManifestIntegrations(m as Record<string, unknown>).map((e) => ({
    id: e.id,
    version: e.version,
    // AFPS §4.4 wildcard — preserve the `"*"` literal verbatim instead
    // of spreading the string into `["*"]`.
    ...(e.tools !== undefined ? { tools: isToolsWildcard(e.tools) ? e.tools : [...e.tools] } : {}),
    ...(e.scopes !== undefined ? { scopes: [...e.scopes] } : {}),
  }));

  if (opts.summaryOnly) return { integrations };

  const declaredSkills = opts.versioned
    ? Object.entries(
        (m as { dependencies?: { skills?: Record<string, string> } }).dependencies?.skills ?? {},
      ).map(([id, version]) => ({ id, ...(version ? { version } : {}) }))
    : (await resolveDeclaredSkills(m, orgId))
        .filter((s) => s.resolved)
        .map((s) => ({
          id: s.id,
          ...(s.version ? { version: s.version } : {}),
          ...(s.name ? { name: s.name } : {}),
          ...(s.description ? { description: s.description } : {}),
        }));
  const skillWritable = await homeWritableForPackages(
    opts.c,
    declaredSkills.map((s) => s.id),
    opts.accessible,
  );
  const skillDeps = declaredSkills.map((s) => ({
    ...s,
    home_writable: skillWritable.get(s.id) ?? false,
  }));
  return {
    skills: skillDeps,
    // AFPS §4.1 mcp_servers dependency group ({ id: version-range }). Agents
    // can declare these via an imported manifest even though the dashboard
    // editor doesn't surface them — return them so the detail response is a
    // faithful projection of the manifest.
    mcp_servers: Object.entries(
      (m as { dependencies?: { mcp_servers?: Record<string, string> } }).dependencies
        ?.mcp_servers ?? {},
    ).map(([id, version]) => ({ id, version })),
    integrations,
  };
}

/**
 * Build the canonical Agent detail DTO — the exact object the `GET` agent
 * detail endpoint serializes. Extracted so mutating endpoints (create / update /
 * fork / restore) can echo the full resource instead of an id-only stub
 * (issue #646), reusing the single GET serializer.
 *
 * `requireAccess` defaults to `true` (the GET semantics: the agent must be
 * ACTIVE in the current space). Mutation responses pass `false` — the caller
 * just wrote the agent within their org, so org-scope is the right gate and the
 * activation gate must not 404 a successful write that nothing switched on.
 *
 * Returns `null` when the agent is not found (or not accessible under
 * `requireAccess`), so the GET wrapper can map it to a 404 and mutation
 * callers to a 500 (a just-written agent must be re-readable).
 */
export async function buildAgentDetailDto(
  c: Context<AppEnv>,
  opts: { itemId?: string; requireAccess?: boolean; version?: string } = {},
): Promise<Record<string, unknown> | null> {
  const scope = getSpaceScope(c);
  const { orgId, spaceId } = scope;
  const itemId = opts.itemId ?? getItemId(c);
  const requireAccess = opts.requireAccess !== false;
  // `agents:run` without `agents:read`: the caller is handed what the launch
  // form needs and nothing an author would call the agent's content — the same
  // fields a system agent already withholds, plus the composition and the
  // authoring metadata (RBAC spec §3.4). The agent's integrations are not
  // content: a launcher connects them, so they stay.
  const summaryOnly = agentReadIsSummary(c);

  const [agent, rawItem, versionCount, latestVersionDate, accessible] = await Promise.all([
    requireAccess ? getPackageForRead(itemId, orgId, spaceId) : getPackage(itemId, orgId),
    getOrgItem(orgId, itemId, CONFIG_BY_TYPE.agent),
    getVersionCount(itemId),
    getLatestVersionCreatedAt(itemId),
    packageAccessSpaces(c),
  ]);

  if (!agent) {
    return null;
  }

  // WHICH definition this page renders (plan decision 5). An explicit
  // `?version=` is honoured — `draft` only for a caller who may write the agent,
  // the same refusal the run route makes from the same predicate. With no
  // selector, `defaultDefinitionSelector` answers: the author's DRAFT, else the
  // latest PUBLISHED version, else — nothing published at all — the draft in
  // read-only, because a readable package whose page 404s is a link the list
  // just promised and cannot honour. Running it still refuses (the launch keeps
  // its `404 no_published_version`), and `definition` below tells the reader
  // which of the two they have so the SPA can say so.
  const explicit = opts.version?.trim();
  // ONE read of the authority, for both halves of the decision: which view is
  // the default, and whether an explicit `draft` is the caller's to ask for.
  const { selector: defaultSel, writable } = await defaultDefinitionSelector(c, agent, accessible);
  if (explicit === VERSION_SELECTOR_DRAFT && !writable) throw draftNotWritable(agent.id);
  const versionSel = explicit || defaultSel;
  const effective =
    versionSel === VERSION_SELECTOR_DRAFT ? null : await resolveAgentRunVersion(agent, versionSel);
  // A published SNAPSHOT was substituted — not merely "a selector was named".
  // A system agent ships its definition with the platform and resolves to
  // itself whatever the selector says, so it stays on the draft projection of
  // the dependency groups, which is the one that enriches skills from the
  // catalog.
  const versioned = effective?.overrideVersionLabel !== undefined;
  const m = effective?.agent.manifest ?? agent.manifest;
  const effectivePrompt = effective?.agent.prompt ?? agent.prompt;

  // The wire name for the projection above: `draft` is the working copy,
  // `published` any `package_versions` snapshot (the `latest` one by default,
  // or the one an explicit `?version=` named).
  const definition = versionSel === VERSION_SELECTOR_DRAFT ? "draft" : "published";

  const dependencies = await buildDependencyGroups(m, orgId, {
    versioned,
    summaryOnly,
    c,
    accessible,
  });

  const { values: storedValues, locked: lockedFields } = await getSpacePackageSettings(
    { orgId, spaceId },
    agent.id,
  );

  // Both are the CALLER's view of the agent's activity: without
  // `runs:read-all` the last run and the in-flight count are the caller's own
  // runs, not a colleague's.
  const visibility = runVisibilityFilter(c);
  const [lastRun, runningCount, active] = await Promise.all([
    getLastRun(scope, agent.id, visibility),
    getRunningRunsForPackage(scope, agent.id, visibility),
    // The space's switch, answered by the page that carries it. Reading an
    // agent never requires it to be active — this detail is exactly what a
    // caller opens to put a switched-off agent back on — so the verdict travels
    // in the payload instead of turning the read into a 404.
    hasPackageAccess(scope, agent.id),
  ]);

  const parsed = parseScopedName(m.name);

  const hasUnarchivedChanges = computeHasUnpublishedChanges(
    agent.source,
    versionCount,
    rawItem?.updatedAt ? new Date(rawItem.updatedAt) : null,
    latestVersionDate,
  );

  return {
    id: agent.id,
    display_name: m.display_name,
    description: m.description,
    source: agent.source,
    // Canonical scope format includes the `@` sigil — same format the
    // `{scope}` path params accept (issue #629).
    scope: parsed ? `@${parsed.scope}` : null,
    version: m.version ?? null,
    // WHICH of the two definitions the fields above were projected from — the
    // author's working copy or a published snapshot. Emitted unconditionally
    // and for every caller: `home_writable` alone cannot answer it, because a
    // reader with no authority also lands on the draft when the agent has
    // never been published, and that is precisely the pair the SPA renders as
    // "never published — you are seeing the author's work in progress" with
    // Launch disabled.
    definition,
    dependencies,
    // The agent's ONE parameter schema, plus the per-space layers the
    // launch form needs: `values` are the editor's stored defaults and
    // `locked_fields` the fields it froze (not asked at launch, not
    // overridable). The three members are always present — a manifest with no
    // `input` section can still carry stored values from an earlier manifest.
    //
    // A summary read gets the locks but not the values behind them: a locked
    // field is one the launcher never supplies (the run refuses it with 400
    // `locked_input_field`), so its stored value — the editor's, often a
    // credential or an account id — has no place in a launch payload. The
    // NAMES stay: they are what tells the form to render the field as imposed
    // instead of asking for it (issue #1338).
    input: {
      ...(m.input ?? { schema: { type: "object", properties: {} } }),
      values: summaryOnly ? withoutLockedFields(storedValues, lockedFields) : storedValues,
      locked_fields: lockedFields,
    },
    ...(m.output ? { output: m.output } : {}),
    running_runs: runningCount,
    last_run: lastRun
      ? {
          id: lastRun.id,
          status: lastRun.status,
          started_at: lastRun.startedAt,
          duration: lastRun.duration,
        }
      : null,
    // What a run actually gets: the EFFECTIVE manifest's `timeout` clamped to
    // `PLATFORM_RUN_LIMITS.timeout_ceiling_seconds` (or the platform default
    // when none is declared). Emitted UNCONDITIONALLY — the declared value is
    // only visible through `manifest`, which the branch below withholds from
    // system agents, so making this field conditional too would leave a system
    // agent's cap undiscoverable from the API.
    effective_timeout_seconds: resolveRunTimeout(m.timeout).effectiveSeconds,
    // Whether this SPACE runs the agent — the same rule `GET /api/agents`
    // answers per row, emitted here so a loaded detail page never has to read a
    // second endpoint to learn it. Unconditional, including on a summary read:
    // a launcher needs it most.
    active,
    // Which space's `agents:write` governs this agent, and whether THIS caller
    // holds it (`homeWireForCaller`, RBAC spec §6.9). Both emitted
    // UNCONDITIONALLY, for the same reason as the timeout above: a summary read
    // still needs to know it may not edit, and an absent `home_writable` would
    // read as "not answered yet" rather than "no".
    ...homeWireForCaller(
      { type: "agent", source: agent.source, homeSpaceId: rawItem?.homeSpaceId ?? null },
      accessible,
    ),
    // The authoring history: who it was forked from, how many versions stand
    // behind it, whether the draft is ahead of them. A summary read omits it —
    // a launcher does not edit or publish.
    ...(summaryOnly
      ? {}
      : {
          version_count: versionCount,
          has_unarchived_changes: hasUnarchivedChanges,
          forked_from: rawItem?.forked_from ?? null,
        }),
    ...(agent.source !== "system" && rawItem && !summaryOnly
      ? {
          manifest: m,
          updatedAt: rawItem.updatedAt,
          lock_version: rawItem.lock_version,
          prompt: effectivePrompt,
        }
      : {}),
  };
}

export async function agentDetailHandler(c: Context<AppEnv>) {
  const dto = await buildAgentDetailDto(c, { version: c.req.query("version") });
  if (!dto) {
    throw notFound(`Agent '${getItemId(c)}' not found`);
  }
  return c.json(dto);
}
