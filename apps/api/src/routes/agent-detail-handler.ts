// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { getPackage, getPackageWithAccess } from "../services/package-catalog.ts";
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
 * `requireAccess`), so the GET wrapper can map it to a 404 and mutation callers
 * can fall back to the legacy envelope.
 */
export async function buildAgentDetailDto(
  c: Context<AppEnv>,
  opts: { itemId?: string; requireAccess?: boolean } = {},
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

  const m = agent.manifest;

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
      skills: agent.skills.map((s) => ({
        id: s.id,
        ...(s.version ? { version: s.version } : {}),
        ...(s.name ? { name: s.name } : {}),
        ...(s.description ? { description: s.description } : {}),
      })),
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
          manifest: agent.manifest,
          updatedAt: rawItem.updatedAt,
          lock_version: rawItem.lock_version,
          prompt: agent.prompt,
        }
      : {}),
  };
}

export async function agentDetailHandler(c: Context<AppEnv>) {
  const dto = await buildAgentDetailDto(c, {});
  if (!dto) {
    throw notFound(`Agent '${getItemId(c)}' not found`);
  }
  return c.json(dto);
}
