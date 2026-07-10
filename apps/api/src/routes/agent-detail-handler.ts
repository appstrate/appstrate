// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  getPackage,
  getPackageWithAccess,
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
import { getPackageConfig } from "../services/application-packages.ts";
import { isToolsWildcard, parseManifestIntegrations } from "@appstrate/core/dependencies";
import { parseScopedName } from "@appstrate/core/naming";
import { mergeWithDefaults, asJSONSchemaObject } from "@appstrate/core/form";
import { getItemId } from "./packages.ts";
import { notFound } from "../lib/errors.ts";
import { getAppScope } from "../lib/scope.ts";

/**
 * Build the canonical Agent detail DTO — the exact object the `GET` agent
 * detail endpoint serializes. Extracted so mutating endpoints (create / update /
 * fork / restore) can echo the full resource instead of an id-only stub
 * (issue #646), reusing the single GET serializer.
 *
 * `requireAccess` defaults to `true` (the GET semantics: agent must be installed
 * in the current app). Mutation responses pass `false` — the caller just wrote
 * the agent within their org, so org-scope is the right gate and the app-install
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
  const scope = getAppScope(c);
  const { orgId, applicationId } = scope;
  const itemId = opts.itemId ?? getItemId(c);
  const requireAccess = opts.requireAccess !== false;

  const [agent, rawItem, versionCount, latestVersionDate] = await Promise.all([
    requireAccess ? getPackageWithAccess(itemId, orgId, applicationId) : getPackage(itemId, orgId),
    getOrgItem(orgId, itemId, CONFIG_BY_TYPE.agent),
    getVersionCount(itemId),
    getLatestVersionCreatedAt(itemId),
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

  // Both branches project off the EFFECTIVE manifest, never off the package
  // object (#878), but they expose different sets — a wire inconsistency that
  // predates this code: a versioned detail lists every DECLARED skill (bare
  // id + range, straight from the manifest — no catalog read) so the
  // dependency-override UI can offer a pin for one that is missing, while the
  // draft detail lists only skills the org catalog resolves, enriched with
  // display metadata. `use-agent-readiness.ts` mirrors the server's
  // missing-skill check against the draft array, so widening it here would
  // silently stop the client flagging a missing skill. Unifying the two — one
  // array of declared skills carrying `resolved` — is a wire change, tracked
  // separately.
  const skillDeps = versioned
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

  const packageConfig = await getPackageConfig(applicationId, agent.id);

  const [lastRun, runningCount] = await Promise.all([
    getLastRun(scope, agent.id, null),
    getRunningRunsForPackage(scope, agent.id),
  ]);

  const configWithDefaults = m.config?.schema
    ? mergeWithDefaults(asJSONSchemaObject(m.config.schema), packageConfig.config)
    : {};

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
    dependencies: {
      skills: skillDeps,
      // AFPS §4.1 mcp_servers dependency group ({ id: version-range }). Agents
      // can declare these via an imported manifest even though the dashboard
      // editor doesn't surface them — return them so the detail response is a
      // faithful projection of the manifest.
      mcp_servers: Object.entries(
        (m as { dependencies?: { mcp_servers?: Record<string, string> } }).dependencies
          ?.mcp_servers ?? {},
      ).map(([id, version]) => ({ id, version })),
      integrations: parseManifestIntegrations(m as Record<string, unknown>).map((e) => ({
        id: e.id,
        version: e.version,
        // AFPS §4.4 wildcard — preserve the `"*"` literal verbatim instead
        // of spreading the string into `["*"]`.
        ...(e.tools !== undefined
          ? { tools: isToolsWildcard(e.tools) ? e.tools : [...e.tools] }
          : {}),
        ...(e.scopes !== undefined ? { scopes: [...e.scopes] } : {}),
      })),
    },
    ...(m.input ? { input: m.input } : {}),
    ...(m.output ? { output: m.output } : {}),
    config: {
      ...(m.config ?? { schema: { type: "object", properties: {} } }),
      current: configWithDefaults,
    },
    running_runs: runningCount,
    last_run: lastRun
      ? {
          id: lastRun.id,
          status: lastRun.status,
          started_at: lastRun.startedAt,
          duration: lastRun.duration,
        }
      : null,
    version_count: versionCount,
    has_unarchived_changes: hasUnarchivedChanges,
    forked_from: rawItem?.forked_from ?? null,
    ...(agent.source !== "system" && rawItem
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
