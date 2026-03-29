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
import { resolveProviderProfiles } from "../services/connection-profiles.ts";
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
  const queryProfileId = c.req.query("profileId");

  // Build providerProfiles map via shared resolution (org → bindings, user → direct)
  const manifestProviders = resolveManifestProviders(m);
  const providerProfiles = await resolveProviderProfiles(
    manifestProviders,
    actor,
    flow.id,
    orgId,
    queryProfileId,
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

  const [currentConfig, lastExec, runningCount] = await Promise.all([
    getPackageConfig(orgId, flow.id),
    getLastExecution(flow.id, null, orgId),
    getRunningExecutionsForPackage(flow.id),
  ]);

  const configWithDefaults = m.config?.schema
    ? mergeWithDefaults(asJSONSchemaObject(m.config.schema), currentConfig)
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
      ...(m.input
        ? {
            input: {
              schema: m.input.schema,
              ...(m.input.propertyOrder ? { propertyOrder: m.input.propertyOrder } : {}),
              ...(m.input.fileConstraints ? { fileConstraints: m.input.fileConstraints } : {}),
              ...(m.input.uiHints ? { uiHints: m.input.uiHints } : {}),
            },
          }
        : {}),
      ...(m.output
        ? {
            output: {
              schema: m.output.schema,
              ...(m.output.propertyOrder ? { propertyOrder: m.output.propertyOrder } : {}),
              ...(m.output.fileConstraints ? { fileConstraints: m.output.fileConstraints } : {}),
              ...(m.output.uiHints ? { uiHints: m.output.uiHints } : {}),
            },
          }
        : {}),
      config: {
        schema: m.config?.schema ?? { type: "object", properties: {} },
        current: configWithDefaults,
        ...(m.config?.propertyOrder ? { propertyOrder: m.config.propertyOrder } : {}),
        ...(m.config?.fileConstraints ? { fileConstraints: m.config.fileConstraints } : {}),
        ...(m.config?.uiHints ? { uiHints: m.config.uiHints } : {}),
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
