// SPDX-License-Identifier: Apache-2.0

/**
 * Provider package CRUD service — data access and business logic for providers.
 * Mirrors the patterns in package-items/crud.ts for skills/tools/agents.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  applicationPackages,
  applicationProviderCredentials,
  packages,
  userProviderConnections,
} from "@appstrate/db/schema";
import { AFPS_SCHEMA_URLS } from "@appstrate/core/validation";
import { isValidVersion } from "@appstrate/core/semver";
import { zipArtifact } from "@appstrate/core/zip";
import { encryptCredentials } from "@appstrate/connect";
import { orgOrSystemFilter } from "../lib/package-helpers.ts";
import { isSystemPackage } from "./system-packages.ts";
import { createVersionAndUpload } from "./package-versions.ts";
import { listPackages } from "./agent-service.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { logger } from "../lib/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderManifestData {
  id: string;
  version?: string;
  displayName: string;
  description?: string;
  author?: string;
  iconUrl?: string;
  categories?: string[];
  docsUrl?: string;
  definition: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Get a single provider package by ID, verifying org ownership. */
export async function getProvider(orgId: string, providerId: string) {
  const [row] = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest, source: packages.source })
    .from(packages)
    .where(
      and(orgOrSystemFilter(orgId), eq(packages.id, providerId), eq(packages.type, "provider")),
    )
    .limit(1);

  return row ?? null;
}

/** Get application-level provider credentials for a specific app. */
export async function getAppProviderCredentials(applicationId: string) {
  return db
    .select({
      providerId: applicationProviderCredentials.providerId,
      credentialsEncrypted: applicationProviderCredentials.credentialsEncrypted,
      enabled: applicationProviderCredentials.enabled,
    })
    .from(applicationProviderCredentials)
    .where(eq(applicationProviderCredentials.applicationId, applicationId));
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** Create a new custom provider package. */
export async function createProvider(
  orgId: string,
  data: ProviderManifestData,
  applicationId: string | null,
  createdBy: string,
  adminCredentials?: Record<string, string>,
): Promise<void> {
  const manifest = buildManifest(data);

  await db.transaction(async (tx) => {
    await tx
      .insert(packages)
      .values({
        id: data.id,
        orgId,
        type: "provider",
        source: "local",
        draftManifest: manifest,
        draftContent: "",
        createdBy,
      })
      .onConflictDoNothing();

    if (applicationId) {
      // Install in the application so it's visible via listAccessiblePackages
      await tx
        .insert(applicationPackages)
        .values({ applicationId, packageId: data.id, config: {} })
        .onConflictDoNothing();

      await upsertAppCredentials(tx, applicationId, data.id, adminCredentials, true);
    }
  });

  await createProviderVersion(data.id, manifest, createdBy);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/** Update an existing custom provider's manifest. */
export async function updateProvider(
  orgId: string,
  providerId: string,
  data: Omit<ProviderManifestData, "id">,
  applicationId: string | null,
  adminCredentials?: Record<string, string>,
): Promise<void> {
  const manifest = buildManifest({ ...data, id: providerId });

  await db.transaction(async (tx) => {
    await tx
      .update(packages)
      .set({ draftManifest: manifest, updatedAt: new Date() })
      .where(and(eq(packages.id, providerId), eq(packages.orgId, orgId)));

    if (adminCredentials && Object.keys(adminCredentials).length > 0 && applicationId) {
      await upsertAppCredentials(tx, applicationId, providerId, adminCredentials, true);
    }
  });
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** Set or update provider credentials for an application. */
export async function configureCredentials(
  applicationId: string,
  providerId: string,
  credentials?: Record<string, string>,
  enabled?: boolean,
): Promise<void> {
  const hasCredentials = credentials && Object.keys(credentials).length > 0;

  const setClause: Record<string, unknown> = { updatedAt: new Date() };
  if (hasCredentials) setClause.credentialsEncrypted = encryptCredentials(credentials);
  if (enabled !== undefined) setClause.enabled = enabled;

  await db
    .insert(applicationProviderCredentials)
    .values({
      applicationId,
      providerId,
      credentialsEncrypted: hasCredentials
        ? encryptCredentials(credentials)
        : encryptCredentials({}),
      enabled: enabled ?? true,
    })
    .onConflictDoUpdate({
      target: [
        applicationProviderCredentials.applicationId,
        applicationProviderCredentials.providerId,
      ],
      set: setClause,
    });
}

/** Delete provider credentials for an application. */
export async function deleteCredentials(applicationId: string, providerId: string): Promise<void> {
  await db
    .delete(applicationProviderCredentials)
    .where(
      and(
        eq(applicationProviderCredentials.applicationId, applicationId),
        eq(applicationProviderCredentials.providerId, providerId),
      ),
    );
}

/** Invalidate all user connections for a provider credential in an org. */
export async function invalidateConnections(
  orgId: string,
  providerId: string,
  providerCredentialId: string,
): Promise<void> {
  await db
    .delete(userProviderConnections)
    .where(
      and(
        eq(userProviderConnections.providerId, providerId),
        eq(userProviderConnections.orgId, orgId),
        eq(userProviderConnections.providerCredentialId, providerCredentialId),
      ),
    );
  logger.info("Invalidated user connections after credential update", {
    providerId,
    orgId,
    providerCredentialId,
  });
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/** Delete a custom provider. Returns usage count if in use. */
export async function deleteProvider(
  orgId: string,
  providerId: string,
): Promise<{ ok: true } | { ok: false; usageCount: number }> {
  const usageCount = await countProviderUsage(orgId, providerId);
  if (usageCount > 0) return { ok: false, usageCount };

  await db.delete(packages).where(and(eq(packages.orgId, orgId), eq(packages.id, providerId)));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Usage counting
// ---------------------------------------------------------------------------

/**
 * Count how many agents reference each provider in their manifest dependencies.
 * Returns a Map<providerId, count>.
 */
export async function countAllProviderUsage(orgId: string): Promise<Map<string, number>> {
  const allAgents = await listPackages(orgId, "agent");
  const usage = new Map<string, number>();
  for (const agent of allAgents) {
    for (const svc of resolveManifestProviders(agent.manifest)) {
      usage.set(svc.id, (usage.get(svc.id) ?? 0) + 1);
    }
  }
  return usage;
}

/** Count how many agents reference a specific provider. */
async function countProviderUsage(orgId: string, providerId: string): Promise<number> {
  const usage = await countAllProviderUsage(orgId);
  return usage.get(providerId) ?? 0;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Check if a provider is a built-in system package. */
export { isSystemPackage as isSystemProvider };

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

function buildManifest(data: ProviderManifestData): Record<string, unknown> {
  return {
    $schema: AFPS_SCHEMA_URLS.provider,
    name: data.id,
    type: "provider",
    version: data.version ?? "1.0.0",
    displayName: data.displayName,
    description: data.description,
    author: data.author,
    iconUrl: data.iconUrl,
    categories: data.categories,
    docsUrl: data.docsUrl,
    definition: data.definition,
  };
}

/** Upsert credentials into applicationProviderCredentials. Works inside a transaction. */
async function upsertAppCredentials(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  applicationId: string,
  providerId: string,
  adminCredentials?: Record<string, string>,
  enabled?: boolean,
): Promise<void> {
  const hasAdminCreds = adminCredentials && Object.keys(adminCredentials).length > 0;
  await tx
    .insert(applicationProviderCredentials)
    .values({
      applicationId,
      providerId,
      credentialsEncrypted: hasAdminCreds
        ? encryptCredentials(adminCredentials)
        : encryptCredentials({}),
      enabled: enabled ?? true,
    })
    .onConflictDoUpdate({
      target: [
        applicationProviderCredentials.applicationId,
        applicationProviderCredentials.providerId,
      ],
      set: {
        ...(hasAdminCreds ? { credentialsEncrypted: encryptCredentials(adminCredentials) } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        updatedAt: new Date(),
      },
    });
}

/** Create a version snapshot for a provider (non-fatal on error). */
async function createProviderVersion(
  packageId: string,
  manifest: Record<string, unknown>,
  createdBy: string,
): Promise<void> {
  const version = manifest.version as string | undefined;
  if (!version || !isValidVersion(version)) return;

  try {
    const entries: Record<string, Uint8Array> = {
      "manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    };
    const zipBuffer = Buffer.from(zipArtifact(entries, 6));
    await createVersionAndUpload({ packageId, version, createdBy, zipBuffer, manifest });
  } catch (error) {
    logger.warn("Provider version creation failed (non-fatal)", { packageId, error });
  }
}
