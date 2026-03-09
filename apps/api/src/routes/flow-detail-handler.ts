import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { getPackage } from "../services/flow-service.ts";
import { getPackageById } from "../services/package-items.ts";
import { getVersionCount, getLatestVersionCreatedAt } from "../services/package-versions.ts";
import {
  getAdminConnections,
  getPackageConfig,
  getLastExecution,
  getRunningExecutionsForPackage,
} from "../services/state.ts";
import { getEffectiveProfileId } from "../services/connection-profiles.ts";
import { resolveProviderStatuses } from "../services/connection-manager.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { parseScopedName } from "@appstrate/core/naming";
import { getItemId } from "./packages.ts";

export async function flowDetailHandler(c: Context<AppEnv>) {
  const orgId = c.get("orgId");
  const user = c.get("user");
  const itemId = getItemId(c);

  const [flow, rawItem, versionCount, latestVersionDate] = await Promise.all([
    getPackage(itemId, orgId),
    getPackageById(itemId),
    getVersionCount(itemId),
    getLatestVersionCreatedAt(itemId),
  ]);

  if (!flow) {
    return c.json({ error: "NOT_FOUND", message: `Flow '${itemId}' not found` }, 404);
  }

  const m = flow.manifest;
  const queryProfileId = c.req.query("profileId");

  const [adminConns, userProfileId] = await Promise.all([
    getAdminConnections(orgId, flow.id),
    queryProfileId ? Promise.resolve(queryProfileId) : getEffectiveProfileId(user.id, flow.id),
  ]);

  const providerStatuses = await resolveProviderStatuses(
    resolveManifestProviders(m),
    adminConns,
    orgId,
    userProfileId,
  );

  const [currentConfig, lastExec, runningCount] = await Promise.all([
    getPackageConfig(orgId, flow.id),
    getLastExecution(flow.id, user.id, orgId),
    getRunningExecutionsForPackage(flow.id, user.id),
  ]);

  // Merge defaults with current config
  const configWithDefaults: Record<string, unknown> = {};
  if (m.config?.schema?.properties) {
    for (const [key, prop] of Object.entries(m.config.schema.properties)) {
      configWithDefaults[key] = currentConfig[key] ?? prop.default ?? null;
    }
  }

  const parsed = parseScopedName(m.name);

  const hasUnpublishedChanges =
    flow.source !== "system" && rawItem
      ? versionCount > 0 && latestVersionDate
        ? (rawItem.updatedAt ?? new Date()) > latestVersionDate
        : versionCount === 0
      : false;

  return c.json({
    flow: {
      id: flow.id,
      displayName: m.displayName,
      description: m.description,
      source: flow.source,
      scope: parsed?.scope ?? null,
      version: m.version ?? null,
      requires: {
        providers: providerStatuses,
        skills: flow.skills.map((s) => ({
          id: s.id,
          version: s.version ?? "*",
          ...(s.name ? { name: s.name } : {}),
          ...(s.description ? { description: s.description } : {}),
        })),
        extensions: flow.extensions.map((e) => ({
          id: e.id,
          version: e.version ?? "*",
          ...(e.name ? { name: e.name } : {}),
          ...(e.description ? { description: e.description } : {}),
        })),
      },
      ...(m.input ? { input: { schema: m.input.schema } } : {}),
      ...(m.output ? { output: { schema: m.output.schema } } : {}),
      config: {
        schema: m.config?.schema ?? { type: "object", properties: {} },
        current: configWithDefaults,
      },
      runningExecutions: runningCount,
      lastExecution: lastExec
        ? {
            id: lastExec.id,
            status: lastExec.status,
            startedAt: lastExec.startedAt,
            duration: lastExec.duration,
          }
        : null,
      versionCount,
      hasUnpublishedChanges,
      forkedFrom: rawItem?.forkedFrom ?? null,
      ...(flow.source !== "system" && rawItem
        ? {
            manifest: flow.manifest,
            updatedAt: rawItem.updatedAt,
            lockVersion: rawItem.version,
            prompt: flow.prompt,
          }
        : {}),
    },
  });
}
