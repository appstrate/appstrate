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
import { decryptCredentials, readCredentialField, resolveHttpDelivery } from "@appstrate/connect";
import { getToolUrlPatterns, integrationManifestSchema } from "@appstrate/core/integration";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";

import { logger } from "../lib/logger.ts";
import type { Actor } from "../lib/actor.ts";

export interface ResolveIntegrationsInput {
  applicationId: string;
  /** The actor whose connections to lookup — `null` skips integration resolution entirely. */
  actor: Actor | null;
  /**
   * Agent's `dependencies.integrations` map (`packageId → versionRange | rich object`).
   * Accepts both the legacy bare-version-string shape and the niveau 2
   * rich form (`{ version, tools?, scopes? }`). The resolver now reads
   * tools[] from the rich form and propagates it to
   * `IntegrationSpawnSpec.toolAllowlist` for sidecar-side enforcement
   * (Phase 3). Legacy / no-tools entries skip the field, preserving the
   * "all tools allowed" default.
   */
  integrationDeps: Record<string, unknown> | undefined;
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

  // Parse the rich form once so we can hand the per-integration
  // `tools[]` selection (and explicit `scopes[]`) to `resolveOne`
  // alongside the package id.
  const entries = parseManifestIntegrations({ dependencies: { integrations: integrationDeps } });
  const out: IntegrationSpawnSpec[] = [];
  for (const entry of entries) {
    try {
      const spec = await resolveOne(entry.id, applicationId, actor, entry.tools);
      if (spec) out.push(spec);
    } catch (err) {
      logger.warn("integration resolve failed; skipping", {
        packageId: entry.id,
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
  agentToolSelection: readonly string[] | undefined,
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

  // (c) Resolve connections + build spawnEnv from delivery.env mappings
  // AND httpDeliveryAuths from delivery.http (Phase 1.5).
  //
  // Note: bundle bytes are NOT inlined into the spec — the sidecar fetches
  // them via `GET /internal/integration-bundle/...` at boot because base64
  // encoding a typical (multi-MB) integration bundle blows past Linux's
  // env var size limit.
  //
  // An integration is viable if EITHER `delivery.env` OR `delivery.http`
  // resolved to something — pure-http integrations (no env vars) still
  // need to spawn with an empty `spawnEnv`.
  const deliveries = await resolveDeliveries(packageId, applicationId, actor, manifest);
  if (!deliveries) {
    // resolveDeliveries already logged the reason (missing connection,
    // decrypt failure, no delivery mapping); skip without surfacing further.
    return null;
  }

  // Namespace = the manifest name's slug portion, normalised by the
  // MCP host. We pass the package id; McpHost.normaliseNamespace does
  // the slug + length cap.
  const namespace = packageId;

  // Phase 4 — narrow the MITM URL envelope to the union of urlPatterns
  // declared on the agent-selected tools. Only emitted when EVERY
  // selected tool declared non-empty `urlPatterns` (otherwise we'd
  // refuse legitimate traffic from an under-declared tool, so we leave
  // the field unset and fall back to the per-auth `authorizedUris`).
  const toolUrlEnvelope = computeToolUrlEnvelope(manifest, agentToolSelection);

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
    spawnEnv: deliveries.spawnEnv,
    ...(deliveries.httpDeliveryAuths ? { httpDeliveryAuths: deliveries.httpDeliveryAuths } : {}),
    // Niveau 2 Phase 3 — when the agent declared a tools[] selection
    // for this integration, propagate it to the sidecar's McpHost so
    // `tools/list` is pre-filtered. `undefined` (legacy dep or rich
    // form without tools) preserves the "all tools allowed" default.
    ...(agentToolSelection !== undefined ? { toolAllowlist: agentToolSelection } : {}),
    ...(toolUrlEnvelope !== undefined ? { toolUrlEnvelope } : {}),
  };
}

/**
 * Build the {@link IntegrationSpawnSpec.toolUrlEnvelope} from the agent's
 * tool selection × the integration manifest's `tools.{name}.urlPatterns`.
 *
 * Returns `undefined` (no extra MITM URL enforcement) when:
 *  - The agent didn't restrict tools (`agentToolSelection === undefined`).
 *  - The agent restricted to an empty set (handled by toolAllowlist alone).
 *  - ANY selected tool lacks a `urlPatterns` declaration — we can't
 *    safely narrow the envelope without blocking that tool's legitimate
 *    traffic, so we fall back to per-auth `authorizedUris`.
 *
 * When every selected tool declares patterns, returns the deduplicated
 * union. Methods are unioned per pattern (a pattern declared twice with
 * different methods collapses to the merged set; pattern declared once
 * with methods + once without keeps methods omitted = "any method").
 *
 * Exported for unit testing; production callers go through
 * {@link resolveIntegrationSpawns}.
 */
export function computeToolUrlEnvelope(
  manifest: IntegrationManifest,
  agentToolSelection: readonly string[] | undefined,
): ReadonlyArray<{ pattern: string; methods?: readonly string[] }> | undefined {
  if (agentToolSelection === undefined) return undefined;
  if (agentToolSelection.length === 0) return undefined;
  const merged = new Map<string, { pattern: string; methods?: Set<string>; anyMethod: boolean }>();
  for (const toolName of agentToolSelection) {
    const patterns = getToolUrlPatterns(manifest, toolName);
    if (!patterns || patterns.length === 0) {
      // Under-declared tool — bail out rather than over-restrict.
      return undefined;
    }
    for (const entry of patterns) {
      const existing = merged.get(entry.pattern);
      if (!existing) {
        merged.set(entry.pattern, {
          pattern: entry.pattern,
          ...(entry.methods && entry.methods.length > 0
            ? { methods: new Set(entry.methods) }
            : { anyMethod: true }),
          anyMethod: !entry.methods || entry.methods.length === 0,
        });
      } else if (!existing.anyMethod && entry.methods && entry.methods.length > 0) {
        for (const m of entry.methods) (existing.methods ??= new Set()).add(m);
      } else {
        existing.anyMethod = true;
        delete existing.methods;
      }
    }
  }
  return [...merged.values()].map((e) =>
    e.anyMethod || !e.methods
      ? { pattern: e.pattern }
      : { pattern: e.pattern, methods: [...e.methods].sort() },
  );
}

interface ResolvedDeliveries {
  spawnEnv: Record<string, string>;
  httpDeliveryAuths?: NonNullable<IntegrationSpawnSpec["httpDeliveryAuths"]>;
}

/**
 * Resolve the per-auth delivery plans (env + http) for one integration.
 * Returns `null` when none of the integration's auths produced anything
 * usable (no connections, all decrypt failures, or pure-custom auths
 * that the platform doesn't know how to render).
 *
 * Iterates auths once, decrypts each connection once, then dispatches
 * fields to the two delivery branches independently — avoids double
 * decryption when one auth declares both `env` and `http`.
 */
async function resolveDeliveries(
  packageId: string,
  applicationId: string,
  actor: Actor,
  manifest: IntegrationManifest,
): Promise<ResolvedDeliveries | null> {
  const auths = manifest.auths ?? {};
  if (Object.keys(auths).length === 0) {
    // Integration declares no auth — spawn with no extra env, no MITM.
    return { spawnEnv: {} };
  }

  const spawnEnv: Record<string, string> = {};
  const httpDeliveryAuths: NonNullable<IntegrationSpawnSpec["httpDeliveryAuths"]> = {};
  let resolvedAtLeastOne = false;

  for (const [authKey, auth] of Object.entries(auths)) {
    const ownerPredicate =
      actor.type === "user"
        ? eq(integrationConnections.userId, actor.id)
        : eq(integrationConnections.endUserId, actor.id);

    const [row] = await db
      .select({
        credentialsEncrypted: integrationConnections.credentialsEncrypted,
        expiresAt: integrationConnections.expiresAt,
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
      logger.info("no connection for integration auth; skipping delivery entries", {
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
    // Normalise creds to Record<string, string> for downstream consumers.
    // The OAuth callback stores access_token under `accessToken`; map it
    // explicitly so the manifest's `from: "accessToken"` resolves.
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(creds)) {
      if (typeof v === "string") fields[k] = v;
    }

    // ─── delivery.env ───
    const envMap = auth.delivery?.env;
    if (envMap && Object.keys(envMap).length > 0) {
      for (const [envKey, conf] of Object.entries(envMap)) {
        const value = readCredentialFieldFromRecord(fields, conf.from);
        if (value === undefined || value.length === 0) {
          logger.info("delivery.env source field missing on credentials", {
            packageId,
            authKey,
            envKey,
            from: conf.from,
          });
          continue;
        }
        spawnEnv[envKey] = value;
        resolvedAtLeastOne = true;
      }
    }

    // ─── delivery.http (Phase 1.5) ───
    const httpDecl = auth.delivery?.http;
    if (httpDecl) {
      const plan = resolveHttpDelivery(auth.type, fields, httpDecl);
      if (!plan) {
        logger.info("delivery.http produced no plan (auth missing required fields)", {
          packageId,
          authKey,
          authType: auth.type,
        });
      } else {
        httpDeliveryAuths[authKey] = {
          authType: auth.type,
          headerName: plan.headerName,
          headerPrefix: plan.headerPrefix,
          value: plan.value,
          allowServerOverride: plan.allowServerOverride,
          authorizedUris: [...auth.authorizedUris],
          expiresAtEpochMs: row.expiresAt ? row.expiresAt.getTime() : null,
        };
        resolvedAtLeastOne = true;
      }
    }
  }

  if (!resolvedAtLeastOne) return null;
  return {
    spawnEnv,
    ...(Object.keys(httpDeliveryAuths).length > 0 ? { httpDeliveryAuths } : {}),
  };
}

/**
 * Local wrapper around `readCredentialField` that takes the already-narrowed
 * `Record<string, string>` rather than the loose `Record<string, unknown>`
 * the decrypted blob produces. Keeps the alias-aware lookup (camelCase ↔
 * snake_case) without re-implementing it.
 */
function readCredentialFieldFromRecord(
  fields: Record<string, string>,
  name: string,
): string | undefined {
  return readCredentialField(fields, name);
}
