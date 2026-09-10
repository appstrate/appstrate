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
import { getInstalledPackageSettings } from "../services/space-packages.ts";
import { resolveRunTimeout } from "../services/run-limits.ts";
import { isToolsWildcard, parseManifestIntegrations } from "@appstrate/core/dependencies";
import { parseScopedName } from "@appstrate/core/naming";
import { getItemId } from "./packages.ts";
import { notFound } from "../lib/errors.ts";
import { getSpaceScope } from "../lib/scope.ts";
import {
  agentReadIsSummary,
  homeWireForCaller,
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
 */
async function buildDependencyGroups(
  m: AgentManifest,
  orgId: string,
  opts: { versioned: boolean; summaryOnly: boolean },
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

  const skillDeps = opts.versioned
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
 * `requireAccess` defaults to `true` (the GET semantics: agent must be installed
 * in the current space). Mutation responses pass `false` — the caller just wrote
 * the agent within their org, so org-scope is the right gate and the space-install
 * gate must not 404 a successful write that was not auto-installed.
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

  // Version-aware projection (issue #770). `draft`/omitted reads the live
  // manifest; a concrete version substitutes the published manifest + prompt
  // via the same resolver the run uses, so the detail (config/input/integrations)
  // matches what the run will execute.
  const versionSel = opts.version?.trim();
  const versioned = !!versionSel && versionSel !== VERSION_SELECTOR_DRAFT;
  const effective = versioned ? await resolveAgentRunVersion(agent, versionSel) : null;
  const m = effective?.agent.manifest ?? agent.manifest;
  const effectivePrompt = effective?.agent.prompt ?? agent.prompt;

  const dependencies = await buildDependencyGroups(m, orgId, { versioned, summaryOnly });

  const { values: storedValues, locked: lockedFields } = await getInstalledPackageSettings(
    spaceId,
    agent.id,
  );

  // Both are the CALLER's view of the agent's activity: without
  // `runs:read-all` the last run and the in-flight count are the caller's own
  // runs, not a colleague's.
  const visibility = runVisibilityFilter(c);
  const [lastRun, runningCount] = await Promise.all([
    getLastRun(scope, agent.id, visibility),
    getRunningRunsForPackage(scope, agent.id, visibility),
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
    dependencies,
    // The agent's ONE parameter schema, plus the per-space layers the
    // launch form needs: `values` are the editor's stored defaults and
    // `locked_fields` the fields it froze (not asked at launch, not
    // overridable). Emitted unconditionally — a manifest with no `input`
    // section can still carry stored values from an earlier manifest.
    input: {
      ...(m.input ?? { schema: { type: "object", properties: {} } }),
      values: storedValues,
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
    // Which space's `agents:write` governs this agent, and whether THIS caller
    // holds it (`homeWireForCaller`, RBAC spec §6.9). Both emitted
    // UNCONDITIONALLY, for the same reason as the timeout above: a summary read
    // still needs to know it may not edit, and an absent `home_writable` would
    // read as "not answered yet" rather than "no".
    ...homeWireForCaller(
      c,
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
