// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { getPackageWithAccess } from "../services/package-catalog.ts";
import { getOrgItem } from "../services/package-items/crud.ts";
import { CONFIG_BY_TYPE } from "../services/package-items/config.ts";
import {
  getVersionCount,
  getLatestVersionCreatedAt,
  computeHasUnpublishedChanges,
} from "../services/package-versions.ts";
import { getLastRun, getRunningRunsForPackage } from "../services/state/runs.ts";
import { getPackageConfig } from "../services/application-packages.ts";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { parseScopedName } from "@appstrate/core/naming";
import { mergeWithDefaults, asJSONSchemaObject } from "@appstrate/core/form";
import { getItemId } from "./packages.ts";
import { notFound } from "../lib/errors.ts";
import { getAppScope } from "../lib/scope.ts";

export async function agentDetailHandler(c: Context<AppEnv>) {
  const scope = getAppScope(c);
  const { orgId, applicationId } = scope;
  const itemId = getItemId(c);

  const [agent, rawItem, versionCount, latestVersionDate] = await Promise.all([
    getPackageWithAccess(itemId, orgId, applicationId),
    getOrgItem(orgId, itemId, CONFIG_BY_TYPE.agent),
    getVersionCount(itemId),
    getLatestVersionCreatedAt(itemId),
  ]);

  if (!agent) {
    throw notFound(`Agent '${itemId}' not found`);
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

  return c.json({
    id: agent.id,
    display_name: m.display_name,
    description: m.description,
    source: agent.source,
    scope: parsed?.scope ?? null,
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
        ...(e.tools !== undefined ? { tools: [...e.tools] } : {}),
        ...(e.scopes !== undefined ? { scopes: [...e.scopes] } : {}),
      })),
    },
    ...(m.input ? { input: m.input } : {}),
    ...(m.output ? { output: m.output } : {}),
    config: {
      ...(m.config ?? { schema: { type: "object", properties: {} } }),
      current: configWithDefaults,
    },
    runningRuns: runningCount,
    lastRun: lastRun
      ? {
          id: lastRun.id,
          status: lastRun.status,
          startedAt: lastRun.startedAt,
          duration: lastRun.duration,
        }
      : null,
    versionCount,
    hasUnarchivedChanges,
    forked_from: rawItem?.forked_from ?? null,
    ...(agent.source !== "system" && rawItem
      ? {
          manifest: agent.manifest,
          updatedAt: rawItem.updatedAt,
          lockVersion: rawItem.lockVersion,
          prompt: agent.prompt,
        }
      : {}),
  });
}
