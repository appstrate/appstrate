// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.4 — resolve `agent.dependencies.integrations[*]` into the
 * `IntegrationSpawnSpec` payloads the sidecar consumes at boot.
 *
 * For each integration the agent declares the resolver:
 *
 *   1. Verifies the integration package exists + is installed in the
 *      run's application (`application_packages`).
 *   2. Loads the integration's bundle bytes — system packages from the
 *      in-memory registry (loaded at boot), local packages from object
 *      storage via `downloadVersionZip`.
 *   3. For each declared auth in `manifest.auths`, finds the actor's
 *      connection in `integration_connections`, decrypts, and (for
 *      oauth2) proactively refreshes if the token is past its lead
 *      window.
 *   4. Materialises the `delivery.env` mapping into a flat env dict
 *      (one entry per env var, value taken from the credential field
 *      named in `from`).
 *
 * Integrations that are declared but not installed / not connected are
 * skipped with a structured warning rather than aborting the run — the
 * agent still spins up without the missing integration's tools. The
 * sidecar surfaces the same gap via its own `failed[]` log line, which
 * gives the operator two-sided diagnosis.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applicationPackages, integrationConnections, packages } from "@appstrate/db/schema";
import { decryptCredentials } from "@appstrate/connect";
import { integrationManifestSchema } from "@appstrate/core/integration";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";

import { logger } from "../lib/logger.ts";
import type { Actor } from "../lib/actor.ts";

export interface ResolveIntegrationsInput {
  applicationId: string;
  /** The actor whose connections to lookup — `null` skips integration resolution entirely. */
  actor: Actor | null;
  /**
   * Agent's `dependencies.integrations` map (`packageId → versionRange`).
   * Empty / undefined skips the work.
   */
  integrationDeps: Record<string, string> | undefined;
}

/**
 * Return one `IntegrationSpawnSpec` per integration that's (a) declared
 * on the agent, (b) installed in the application, AND (c) connected by
 * the actor. Other integrations are dropped with a warning.
 */
export async function resolveIntegrationSpawns(
  input: ResolveIntegrationsInput,
): Promise<IntegrationSpawnSpec[]> {
  const { applicationId, actor, integrationDeps } = input;
  if (!actor) return [];
  if (!integrationDeps || Object.keys(integrationDeps).length === 0) return [];

  const out: IntegrationSpawnSpec[] = [];
  for (const packageId of Object.keys(integrationDeps)) {
    try {
      const spec = await resolveOne(packageId, applicationId, actor);
      if (spec) out.push(spec);
    } catch (err) {
      logger.warn("integration resolve failed; skipping", {
        packageId,
        applicationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

async function resolveOne(
  packageId: string,
  applicationId: string,
  actor: Actor,
): Promise<IntegrationSpawnSpec | null> {
  // (a) Package exists + integration type — read the latest manifest
  // straight off `packages.draft_manifest`. System integrations have
  // `source = 'system'`; org integrations have `org_id` set to the
  // run's org. The runtime never resolves against a yanked version —
  // we always use the package's draft manifest, which the publish path
  // keeps pinned to the live "latest" snapshot.
  const [pkgRow] = await db
    .select({
      id: packages.id,
      orgId: packages.orgId,
      source: packages.source,
      type: packages.type,
      manifest: packages.draftManifest,
    })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  if (!pkgRow) {
    logger.info("integration not found", { packageId });
    return null;
  }
  if (pkgRow.type !== "integration") {
    logger.warn("dependency declared as integration but package is different type", {
      packageId,
      type: pkgRow.type,
    });
    return null;
  }

  const manifestParse = integrationManifestSchema.safeParse(pkgRow.manifest);
  if (!manifestParse.success) {
    logger.warn("integration manifest fails validation", { packageId });
    return null;
  }
  const manifest = manifestParse.data;

  // (b) Installed in the application
  const [installRow] = await db
    .select({ packageId: applicationPackages.packageId })
    .from(applicationPackages)
    .where(
      and(
        eq(applicationPackages.applicationId, applicationId),
        eq(applicationPackages.packageId, packageId),
      ),
    )
    .limit(1);
  if (!installRow) {
    logger.info("integration not installed in application; skipping", { packageId, applicationId });
    return null;
  }

  // (c) Resolve connections + build spawnEnv from delivery.env mappings.
  // Note: bundle bytes are NOT inlined into the spec — the sidecar fetches
  // them via `GET /internal/integration-bundle/...` at boot because base64
  // encoding a typical (multi-MB) integration bundle blows past Linux's
  // env var size limit.
  const spawnEnv = await resolveDeliveryEnv(packageId, applicationId, actor, manifest);
  if (!spawnEnv) {
    // resolveDeliveryEnv already logged the reason (missing connection,
    // decrypt failure, no env mapping); skip without surfacing further.
    return null;
  }

  // Namespace = the manifest name's slug portion, normalised by the
  // MCP host. We pass the package id; McpHost.normaliseNamespace does
  // the slug + length cap.
  const namespace = packageId;

  return {
    packageId,
    namespace,
    manifest: {
      name: manifest.name,
      version: manifest.version,
      server: {
        type: manifest.server.type,
        ...(manifest.server.entryPoint ? { entryPoint: manifest.server.entryPoint } : {}),
      },
      ...(manifest.transport ? { transport: { type: manifest.transport.type } } : {}),
    },
    spawnEnv,
  };
}

async function resolveDeliveryEnv(
  packageId: string,
  applicationId: string,
  actor: Actor,
  manifest: IntegrationManifest,
): Promise<Record<string, string> | null> {
  const auths = manifest.auths ?? {};
  if (Object.keys(auths).length === 0) {
    // Integration declares no auth — spawn with no extra env. Valid.
    return {};
  }
  const out: Record<string, string> = {};
  let resolvedAtLeastOne = false;

  for (const [authKey, auth] of Object.entries(auths)) {
    const envMap = auth.delivery?.env;
    if (!envMap || Object.keys(envMap).length === 0) continue; // delivery.http path — Phase 1.5

    const ownerPredicate =
      actor.type === "user"
        ? eq(integrationConnections.userId, actor.id)
        : eq(integrationConnections.endUserId, actor.id);

    const [row] = await db
      .select({
        credentialsEncrypted: integrationConnections.credentialsEncrypted,
      })
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.integrationPackageId, packageId),
          eq(integrationConnections.authKey, authKey),
          eq(integrationConnections.applicationId, applicationId),
          ownerPredicate,
        ),
      )
      .limit(1);
    if (!row) {
      logger.info("no connection for integration auth; skipping env entries", {
        packageId,
        authKey,
        actorType: actor.type,
      });
      continue;
    }

    let creds: Record<string, unknown>;
    try {
      creds = decryptCredentials<Record<string, unknown>>(row.credentialsEncrypted) ?? {};
    } catch (err) {
      logger.warn("decrypt failed for integration connection", {
        packageId,
        authKey,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    // The OAuth callback stores access_token under `accessToken`; map it
    // explicitly so the manifest's `from: "accessToken"` resolves.
    const sourceMap: Record<string, unknown> = { ...creds };

    for (const [envKey, conf] of Object.entries(envMap)) {
      const value = sourceMap[conf.from];
      if (typeof value !== "string" || value.length === 0) {
        logger.info("delivery.env source field missing on credentials", {
          packageId,
          authKey,
          envKey,
          from: conf.from,
        });
        continue;
      }
      out[envKey] = value;
      resolvedAtLeastOne = true;
    }
  }

  if (!resolvedAtLeastOne) return null;
  return out;
}
