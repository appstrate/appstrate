// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, providerCredentials } from "@appstrate/db/schema";
import { getPackage } from "../services/agent-service.ts";
import { getOrgItem, AGENT_CONFIG } from "../services/package-items/index.ts";
import {
  getVersionCount,
  getLatestVersionCreatedAt,
  computeHasUnpublishedChanges,
} from "../services/package-versions.ts";
import { getPackageConfig, getLastRun, getRunningRunsForPackage } from "../services/state/index.ts";
import {
  resolveProviderProfiles,
  resolveActorProfileContext,
  getAgentOrgProfile,
} from "../services/connection-profiles.ts";
import { resolveProviderStatuses } from "../services/connection-manager/index.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { packageToProviderConfig } from "../lib/provider-config.ts";
import { getOAuthCallbackUrl } from "../services/connection-manager/oauth.ts";
import { parseScopedName } from "@appstrate/core/naming";
import { mergeWithDefaults, asJSONSchemaObject } from "@appstrate/core/form";
import { getItemId } from "./packages.ts";
import { notFound } from "../lib/errors.ts";
import { getActor } from "../lib/actor.ts";
import { orgOrSystemFilter } from "../lib/package-helpers.ts";

export async function agentDetailHandler(c: Context<AppEnv>) {
  const orgId = c.get("orgId");
  const appId = c.get("applicationId");
  const actor = getActor(c);
  const itemId = getItemId(c);

  const [agent, rawItem, versionCount, latestVersionDate] = await Promise.all([
    getPackage(itemId, orgId),
    getOrgItem(orgId, itemId, AGENT_CONFIG),
    getVersionCount(itemId),
    getLatestVersionCreatedAt(itemId),
  ]);

  if (!agent) {
    throw notFound(`Agent '${itemId}' not found`);
  }

  const m = agent.manifest;

  // Load org profile, actor profile context, and package config in parallel
  const [agentOrgProfile, { defaultUserProfileId, userProviderOverrides }, packageConfig] =
    await Promise.all([
      getAgentOrgProfile(appId, orgId, agent.id),
      resolveActorProfileContext(actor, agent.id),
      getPackageConfig(appId, agent.id),
    ]);
  const agentOrgProfileId = agentOrgProfile?.id ?? null;
  const agentOrgProfileName = agentOrgProfile?.name ?? null;

  // Build providerProfiles map: org bindings → per-provider overrides → default
  const manifestProviders = resolveManifestProviders(m);
  const providerProfiles = await resolveProviderProfiles(
    manifestProviders,
    defaultUserProfileId,
    userProviderOverrides,
    agentOrgProfileId,
    orgId,
  );

  const providerStatuses = await resolveProviderStatuses(
    manifestProviders,
    providerProfiles,
    orgId,
  );

  // Build populatedProviders: ProviderConfig keyed by provider ID
  const providerIds = [...new Set(manifestProviders.map((p) => p.id))];
  let populatedProviders: Record<string, unknown> = {};
  if (providerIds.length > 0) {
    const [providerPkgs, providerCreds] = await Promise.all([
      db
        .select({
          id: packages.id,
          draftManifest: packages.draftManifest,
          source: packages.source,
        })
        .from(packages)
        .where(
          and(
            orgOrSystemFilter(orgId),
            eq(packages.type, "provider"),
            inArray(packages.id, providerIds),
          ),
        ),
      db
        .select({
          providerId: providerCredentials.providerId,
          credentialsEncrypted: providerCredentials.credentialsEncrypted,
          enabled: providerCredentials.enabled,
        })
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.orgId, orgId),
            inArray(providerCredentials.providerId, providerIds),
          ),
        ),
    ]);
    const credMap = new Map(providerCreds.map((r) => [r.providerId, r]));
    populatedProviders = Object.fromEntries(
      providerPkgs.map((pkg) => [
        pkg.id,
        packageToProviderConfig(
          { id: pkg.id, manifest: pkg.draftManifest, source: pkg.source },
          credMap.get(pkg.id) ?? null,
        ),
      ]),
    );
  }

  const [lastRun, runningCount] = await Promise.all([
    getLastRun(agent.id, null, orgId, appId),
    getRunningRunsForPackage(agent.id, orgId),
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
    agent: {
      id: agent.id,
      displayName: m.displayName,
      description: m.description,
      source: agent.source,
      scope: parsed?.scope ?? null,
      version: m.version ?? null,
      dependencies: {
        providers: providerStatuses,
        skills: agent.skills.map((s) => ({
          id: s.id,
          version: s.version ?? "*",
          ...(s.name ? { name: s.name } : {}),
          ...(s.description ? { description: s.description } : {}),
        })),
        tools: agent.tools.map((e) => ({
          id: e.id,
          version: e.version ?? "*",
          ...(e.name ? { name: e.name } : {}),
          ...(e.description ? { description: e.description } : {}),
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
      populatedProviders,
      callbackUrl: getOAuthCallbackUrl(),
      versionCount,
      hasUnarchivedChanges,
      agentOrgProfileId,
      agentOrgProfileName,
      forkedFrom: rawItem?.forkedFrom ?? null,
      ...(agent.source !== "system" && rawItem
        ? {
            manifest: agent.manifest,
            updatedAt: rawItem.updatedAt,
            lockVersion: rawItem.lockVersion,
            prompt: agent.prompt,
          }
        : {}),
    },
  });
}
