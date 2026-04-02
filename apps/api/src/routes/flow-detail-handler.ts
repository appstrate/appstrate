// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, providerCredentials } from "@appstrate/db/schema";
import { getPackage } from "../services/flow-service.ts";
import { getPackageById } from "../services/package-items/index.ts";
import { getVersionCount, getLatestVersionCreatedAt } from "../services/package-versions.ts";
import {
  getPackageConfig,
  getLastExecution,
  getRunningExecutionsForPackage,
} from "../services/state/index.ts";
import {
  resolveProviderProfiles,
  resolveActorProfileContext,
  getFlowOrgProfile,
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

export async function flowDetailHandler(c: Context<AppEnv>) {
  const orgId = c.get("orgId");
  const actor = getActor(c);
  const itemId = getItemId(c);

  const [flow, rawItem, versionCount, latestVersionDate] = await Promise.all([
    getPackage(itemId, orgId),
    getPackageById(itemId),
    getVersionCount(itemId),
    getLatestVersionCreatedAt(itemId),
  ]);

  if (!flow) {
    throw notFound(`Flow '${itemId}' not found`);
  }

  const m = flow.manifest;

  // Load org profile, actor profile context, and package config in parallel
  const [flowOrgProfile, { defaultUserProfileId, userProviderOverrides }, packageConfig] =
    await Promise.all([
      getFlowOrgProfile(orgId, flow.id),
      resolveActorProfileContext(actor, flow.id),
      getPackageConfig(orgId, flow.id),
    ]);
  const flowOrgProfileId = flowOrgProfile?.id ?? null;
  const flowOrgProfileName = flowOrgProfile?.name ?? null;

  // Build providerProfiles map: org bindings → per-provider overrides → default
  const manifestProviders = resolveManifestProviders(m);
  const providerProfiles = await resolveProviderProfiles(
    manifestProviders,
    defaultUserProfileId,
    userProviderOverrides,
    flowOrgProfileId,
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

  const [lastExec, runningCount] = await Promise.all([
    getLastExecution(flow.id, null, orgId),
    getRunningExecutionsForPackage(flow.id),
  ]);

  const configWithDefaults = m.config?.schema
    ? mergeWithDefaults(asJSONSchemaObject(m.config.schema), packageConfig.config)
    : {};

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
      dependencies: {
        providers: providerStatuses,
        skills: flow.skills.map((s) => ({
          id: s.id,
          version: s.version ?? "*",
          ...(s.name ? { name: s.name } : {}),
          ...(s.description ? { description: s.description } : {}),
        })),
        tools: flow.tools.map((e) => ({
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
      runningExecutions: runningCount,
      lastExecution: lastExec
        ? {
            id: lastExec.id,
            status: lastExec.status,
            startedAt: lastExec.startedAt,
            duration: lastExec.duration,
          }
        : null,
      populatedProviders,
      callbackUrl: getOAuthCallbackUrl(),
      versionCount,
      hasUnpublishedChanges,
      flowOrgProfileId,
      flowOrgProfileName,
      forkedFrom: rawItem?.forkedFrom ?? null,
      ...(flow.source !== "system" && rawItem
        ? {
            manifest: flow.manifest,
            updatedAt: rawItem.updatedAt,
            lockVersion: rawItem.lockVersion,
            prompt: flow.prompt,
          }
        : {}),
    },
  });
}
