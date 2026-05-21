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

import {
  decryptCredentialsToStringMap,
  readCredentialField,
  resolveHttpDelivery,
} from "@appstrate/connect";
import {
  getToolUrlPatterns,
  getApiCallConfig,
  API_CALL_TOOL_NAME,
} from "@appstrate/core/integration";
import type {
  IntegrationManifest,
  ResolvedConnection,
  ResolvedConnectionMap,
} from "@appstrate/core/integration";
// ResolvedConnectionMap is consumed via input prop (`resolvedConnections`) below.
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";

import { logger } from "../lib/logger.ts";
import type { Actor } from "../lib/actor.ts";
import { isIntegrationActive, selectAccessibleConnection } from "./integration-connections.ts";
import { fetchIntegrationManifest } from "./integration-service.ts";

export interface ResolveIntegrationsInput {
  applicationId: string;
  /** The actor whose connections to lookup — `null` skips integration resolution entirely. */
  actor: Actor | null;
  /**
   * The agent's full manifest. Versions come from
   * `dependencies.integrations`, tool/scope selections from the
   * top-level `integrations` block (niveau 2 scope model). The resolver
   * propagates the per-id `tools[]` to `IntegrationSpawnSpec.toolAllowlist`
   * for sidecar-side enforcement (Phase 3).
   */
  agentManifest: Record<string, unknown>;
  /**
   * Snapshot of the cascade frozen at run kickoff
   * (`runs.resolved_connections`). When set, the spawn loader looks up
   * `snapshot[integrationId].connectionId` to pick the one connection
   * (admin pin / run override / schedule override / member pin / auto
   * fallback). When omitted, falls back to live actor-based lookup
   * (auto-pick when the actor has exactly one accessible connection).
   */
  resolvedConnections?: ResolvedConnectionMap | null;
}

/**
 * Return one `IntegrationSpawnSpec` per integration that's (a) declared
 * on the agent, (b) installed in the application, AND (c) connected by
 * the actor. Other integrations are dropped with a warning.
 */
export async function resolveIntegrationSpawns(
  input: ResolveIntegrationsInput,
): Promise<IntegrationSpawnSpec[]> {
  const { applicationId, actor, agentManifest, resolvedConnections } = input;
  if (!actor) return [];

  const entries = parseManifestIntegrations(agentManifest);
  if (entries.length === 0) return [];
  const out: IntegrationSpawnSpec[] = [];
  for (const entry of entries) {
    try {
      const spec = await resolveOne(
        entry.id,
        applicationId,
        actor,
        entry.tools,
        resolvedConnections?.[entry.id] ?? null,
      );
      if (spec) out.push(spec);
    } catch (err) {
      logger.warn("integration resolve failed; skipping", {
        integrationId: entry.id,
        applicationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

async function resolveOne(
  integrationId: string,
  applicationId: string,
  actor: Actor,
  agentToolSelection: readonly string[] | undefined,
  resolvedConnection: ResolvedConnection | null,
): Promise<IntegrationSpawnSpec | null> {
  // (a) Package exists + integration type — read the latest manifest
  // straight off `packages.draft_manifest`. System integrations have
  // `source = 'system'`; org integrations have `org_id` set to the
  // run's org. The runtime never resolves against a yanked version —
  // we always use the package's draft manifest, which the publish path
  // keeps pinned to the live "latest" snapshot.
  const res = await fetchIntegrationManifest(integrationId);
  if (!res.ok) {
    switch (res.failure.kind) {
      case "not_found":
        logger.info("integration not found", { integrationId });
        return null;
      case "not_integration":
        logger.warn("dependency declared as integration but package is different type", {
          integrationId,
          type: res.failure.actualType,
        });
        return null;
      case "invalid_manifest":
        logger.warn("integration manifest fails validation", { integrationId });
        return null;
    }
  }
  const manifest = res.manifest;

  // (b) Installed in the application
  if (!(await isIntegrationActive(integrationId, applicationId))) {
    logger.info("integration not installed in application; skipping", {
      integrationId,
      applicationId,
    });
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
  // provider→integration unification — `server.type: "api_call"` is the
  // serverless kind: no runner to spawn, just the generic credential-injecting
  // tool. Exposed when the agent selected it (least-privilege: the catch-all
  // tool is never auto-granted). `authorizedUris` come from the auth the
  // api_call config resolved to.
  const isApiCallServer = manifest.server?.type === "api_call";
  const apiCallCfg = getApiCallConfig(manifest);
  const exposeApiCall =
    apiCallCfg !== null && (agentToolSelection ?? []).includes(API_CALL_TOOL_NAME);
  const apiCallAuth =
    exposeApiCall && apiCallCfg ? manifest.auths?.[apiCallCfg.authKey] : undefined;
  const apiCallAuthorizedUris = apiCallAuth?.authorizedUris ?? [];
  const apiCallAllowAllUris = apiCallAuth?.allowAllUris ?? false;

  // An integration is viable if EITHER `delivery.env` OR `delivery.http`
  // resolved to something — pure-http integrations (no env vars) still
  // need to spawn with an empty `spawnEnv`. apiCall integrations are
  // viable on a resolved connection alone: their credentials flow at
  // runtime through `/internal/integration-credentials`, and a `custom`
  // auth (no server-side injection) legitimately resolves no delivery.
  const deliveries = await resolveDeliveries(
    integrationId,
    applicationId,
    actor,
    manifest,
    resolvedConnection,
    exposeApiCall,
  );
  if (!deliveries) {
    // resolveDeliveries already logged the reason (missing connection,
    // decrypt failure, no delivery mapping); skip without surfacing further.
    return null;
  }

  // Namespace = the manifest name's slug portion, normalised by the
  // MCP host. We pass the package id; McpHost.normaliseNamespace does
  // the slug + length cap.
  const namespace = integrationId;

  // Phase 4 — narrow the MITM URL envelope to the union of urlPatterns
  // declared on the agent-selected tools (skipped for remote HTTP MCP).
  const isRemoteHttp = manifest.server?.type === "http";
  const toolUrlEnvelope = isRemoteHttp
    ? undefined
    : computeToolUrlEnvelope(manifest, agentToolSelection);

  return {
    integrationId,
    namespace,
    manifest: {
      name: manifest.name,
      version: manifest.version,
      // Serverless integrations (`server.type: "api_call"`) omit `server` in
      // the spec — the sidecar's serverless path (no spec.manifest.server)
      // skips spawn and only wires the generic api_call tool. Real runners
      // (node|python|binary|…) and remote MCP (http) propagate normally.
      ...(manifest.server && !isApiCallServer
        ? {
            server: {
              type: manifest.server.type,
              ...(manifest.server.entryPoint ? { entryPoint: manifest.server.entryPoint } : {}),
              // Phase 7 — propagate the remote MCP URL so the sidecar can open
              // a Streamable HTTP client against it. Mutually exclusive with
              // `entryPoint` (enforced by `integrationManifestSchema`).
              ...(manifest.server.url ? { url: manifest.server.url } : {}),
            },
          }
        : {}),
      ...(manifest.transport ? { transport: { type: manifest.transport.type } } : {}),
    },
    ...(exposeApiCall && apiCallCfg
      ? {
          apiCall: {
            authKey: apiCallCfg.authKey,
            authorizedUris: [...apiCallAuthorizedUris],
            ...(apiCallAllowAllUris ? { allowAllUris: true } : {}),
            ...(apiCallCfg.uploadProtocols.length > 0
              ? { uploadProtocols: apiCallCfg.uploadProtocols }
              : {}),
          },
        }
      : {}),
    spawnEnv: deliveries.spawnEnv,
    // For remote HTTP MCP we deliberately drop `httpDeliveryAuths`: the
    // sidecar's HTTP path reads the access token directly from the
    // credentials source and injects it into the outbound MCP request,
    // bypassing the per-integration MITM listener (which doesn't exist).
    ...(deliveries.httpDeliveryAuths && !isRemoteHttp
      ? { httpDeliveryAuths: deliveries.httpDeliveryAuths }
      : {}),
    // Niveau 2 Phase 3 — least-privilege default: when the agent didn't
    // pick any tool (undefined selection), the allowlist is `[]` and
    // the sidecar's McpHost registers nothing for this integration.
    // The agent author has to explicitly opt into each tool via the
    // editor UI.
    toolAllowlist: agentToolSelection ?? [],
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
 * Resolve the delivery plan (env + http) for ONE connection on this
 * integration. Returns `null` when the connection can't be loaded or
 * its auth declares no usable delivery mapping.
 *
 * The runtime model: one connection per integration. The connection
 * carries its own `authKey` which selects the `manifest.auths[X]`
 * declaration we extract delivery from. OAuth and api_key connections
 * are interchangeable — the chosen one's shape drives credential
 * injection.
 *
 * `resolvedConnection` (the cascade's frozen pick) is the authoritative
 * source when present. Otherwise we fall back to a live auto-pick over
 * the actor's accessible connections on this integration.
 */
async function resolveDeliveries(
  integrationId: string,
  applicationId: string,
  actor: Actor,
  manifest: IntegrationManifest,
  resolvedConnection: ResolvedConnection | null,
  hasApiCall: boolean,
): Promise<ResolvedDeliveries | null> {
  const auths = manifest.auths ?? {};
  if (Object.keys(auths).length === 0) {
    // Integration declares no auth — spawn with no extra env, no MITM.
    return { spawnEnv: {} };
  }

  // Load the one connection chosen by the cascade.
  const row = await selectAccessibleConnection(
    integrationId,
    Object.keys(auths),
    resolvedConnection?.connectionId ?? null,
    { applicationId, actor },
  );

  if (!row) {
    logger.info("no resolved connection for integration; skipping delivery entries", {
      integrationId,
      actorType: actor.type,
      hadSnapshot: resolvedConnection !== null,
    });
    return null;
  }

  const auth = auths[row.authKey];
  if (!auth) {
    // The connection points at an authKey the manifest no longer declares
    // (renamed/removed since the connection was created). Skip — the
    // operator should clean up the orphan.
    logger.warn("resolved connection points at unknown authKey; skipping", {
      integrationId,
      authKey: row.authKey,
      connectionId: row.id,
    });
    return null;
  }

  let fields: Record<string, string>;
  try {
    fields = decryptCredentialsToStringMap(row.credentialsEncrypted);
  } catch (err) {
    logger.warn("decrypt failed for integration connection", {
      integrationId,
      authKey: row.authKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const spawnEnv: Record<string, string> = {};
  const httpDeliveryAuths: NonNullable<IntegrationSpawnSpec["httpDeliveryAuths"]> = {};
  let resolvedAtLeastOne = false;

  // ─── delivery.env ───
  const envMap = auth.delivery?.env;
  if (envMap && Object.keys(envMap).length > 0) {
    for (const [envKey, conf] of Object.entries(envMap)) {
      const value = readCredentialField(fields, conf.from);
      if (value === undefined || value.length === 0) {
        logger.info("delivery.env source field missing on credentials", {
          integrationId,
          authKey: row.authKey,
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
        integrationId,
        authKey: row.authKey,
        authType: auth.type,
      });
    } else {
      httpDeliveryAuths[row.authKey] = {
        ...plan,
        authType: auth.type,
        authorizedUris: [...auth.authorizedUris],
        expiresAtEpochMs: row.expiresAt ? row.expiresAt.getTime() : null,
      };
      resolvedAtLeastOne = true;
    }
  }

  // apiCall integrations stay viable on a resolved connection alone — a
  // `custom` auth resolves no delivery plan but the credential fields are
  // still served (for {{var}} substitution) via the live endpoint.
  if (!resolvedAtLeastOne && !hasApiCall) return null;
  return {
    spawnEnv,
    ...(Object.keys(httpDeliveryAuths).length > 0 ? { httpDeliveryAuths } : {}),
  };
}
