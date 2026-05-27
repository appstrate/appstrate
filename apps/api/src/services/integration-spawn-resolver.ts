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
  decryptCredentialInputsToStringMap,
  resolveAfpsHttpDelivery,
} from "@appstrate/connect";
import type { AfpsHttpDelivery as ConnectAfpsHttpDelivery } from "@appstrate/connect";
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
import {
  getMcpServerRuntime,
  getMcpServerMcpConfigEnv,
  renderMcpConfigEnv,
} from "@appstrate/core/mcp-server";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";

import { logger } from "../lib/logger.ts";
import type { Actor } from "../lib/actor.ts";
import { isIntegrationActive, selectAccessibleConnection } from "./integration-connections.ts";
import { fetchIntegrationManifest, fetchMcpServerManifest } from "./integration-service.ts";
import {
  getIntegrationSourceKind,
  getLocalServerRef,
  getRemoteSource,
  getAppstrateConnectMeta,
  renderCredentialTemplate,
  parseFileMode,
  isSafeDeliveryFilePath,
  DEFAULT_DELIVERY_FILE_MODE,
  type AfpsManifestAuth,
} from "./integration-manifest-helpers.ts";

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
        entry.auth_key,
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
  requiredAuthKey: string | undefined,
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
  // them via `GET /internal/mcp-server-bundle/...` at boot because base64
  // encoding a typical (multi-MB) integration bundle blows past Linux's
  // env var size limit.
  //
  // A serverless integration declares
  // `source.kind: "api"` and no `server`: no runner to spawn, just the generic
  // credential-injecting tool. Exposed when the agent selected it
  // (least-privilege: the catch-all tool is never auto-granted).
  // `authorized_uris` come from the auth the api source resolved to.
  const apiCallCfg = getApiCallConfig(manifest);
  const exposeApiCall =
    apiCallCfg !== null && (agentToolSelection ?? []).includes(API_CALL_TOOL_NAME);
  const apiCallAuth =
    exposeApiCall && apiCallCfg
      ? (manifest.auths?.[apiCallCfg.authKey] as AfpsManifestAuth | undefined)
      : undefined;
  const apiCallAuthorizedUris = apiCallAuth?.authorized_uris ?? [];
  const apiCallAllowAllUris = apiCallAuth?.allow_all_uris ?? false;

  // ── Resolve the sidecar server spec from the AFPS `source`
  // discriminant (replaces the 1.x inline `manifest.server`). ──
  //   - remote → Streamable HTTP MCP (`{ url, transport }`; spawn-mode is
  //              selected by `spec.sourceKind`, not `server.type`).
  //   - local  → resolve the referenced mcp-server package's MCPB manifest
  //              and emit `{ type, entry_point }` from `server.{type, entry_point}`.
  //   - api    → serverless (no `server` in the spec; sidecar skips spawn).
  //
  // Resolved BEFORE `resolveDeliveries` so the mcp-server's `mcp_config.env`
  // template is available for AFPS §7.6 `user_config_key` substitution
  // (CC-4) — local-source integrations can bind a `delivery.env.<var>` to a
  // `${user_config.<key>}` placeholder in the referenced mcp-server's env map.
  const sourceKind = getIntegrationSourceKind(manifest);
  const isRemoteHttp = sourceKind === "remote";
  let serverSpec:
    | {
        type?: string;
        entry_point?: string;
        url?: string;
        transport?: "streamable-http" | "sse";
        serverPackageId?: string;
      }
    | undefined;
  let referencedMcpServer: Awaited<ReturnType<typeof fetchMcpServerManifest>> | null = null;
  if (isRemoteHttp) {
    const remote = getRemoteSource(manifest);
    if (!remote) {
      logger.warn("remote-source integration missing remote.url; skipping", { integrationId });
      return null;
    }
    // AFPS §7.1 — `transport` is `"streamable-http" | "sse"`. The
    // manifest schema enforces the enum + `required`; we forward the
    // declared value verbatim so the sidecar can pick the right MCP
    // client transport. Default to `"streamable-http"` only as a defensive
    // back-compat fallback for any manifest that somehow shipped without
    // the field.
    //
    // `server.type` is intentionally omitted — the sidecar dispatches on
    // `spec.sourceKind === "remote"`. Carrying `"http"` here would collide
    // with the AFPS `mcpServerTypeEnum` (`node|python|binary|uv`).
    const transport: "streamable-http" | "sse" =
      remote.transport === "sse" ? "sse" : "streamable-http";
    serverSpec = { url: remote.url, transport };
  } else if (sourceKind === "local") {
    const ref = getLocalServerRef(manifest);
    if (!ref) {
      logger.warn("local-source integration missing source.server; skipping", { integrationId });
      return null;
    }
    const mcpServer = await fetchMcpServerManifest(ref.name);
    if (!mcpServer) {
      logger.warn("referenced mcp-server could not be resolved; skipping integration", {
        integrationId,
        mcpServerId: ref.name,
      });
      return null;
    }
    referencedMcpServer = mcpServer;
    const run = (mcpServer as { server?: { type?: string; entry_point?: string } }).server;
    // Defensive: mcpServerManifestSchema makes `server.{type,entry_point}`
    // required, so a manifest that parsed (non-null above) always has them.
    // Kept as a fail-closed guard against a future schema relaxation.
    if (!run?.type || !run.entry_point) {
      logger.warn("referenced mcp-server has no runnable server config; skipping", {
        integrationId,
        mcpServerId: ref.name,
      });
      return null;
    }
    // The Appstrate runtime override (`_meta["dev.appstrate/mcp-server"].runtime`)
    // wins over the MCPB `server.type`. MCPB has no `bun` type, so a bun-native
    // server keeps an MCPB-vocabulary `server.type: "node"` and declares
    // `bun` in _meta; the runner then picks the bun interpreter/image.
    const effectiveType = getMcpServerRuntime(mcpServer) ?? run.type;
    // AFPS §7.1 — propagate `source.server.vendored` build-provenance signal
    // through the spawn spec → boot report so operators can audit "this run
    // used a vendored foreign package". Only meaningful for local sources.
    serverSpec = {
      type: effectiveType,
      entry_point: run.entry_point,
      serverPackageId: ref.name,
      ...(typeof ref.vendored === "boolean" ? { vendored: ref.vendored } : {}),
    };
  }
  // sourceKind === "api" (or unknown) → serverless, serverSpec stays undefined.

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
    referencedMcpServer,
    requiredAuthKey,
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

  // Phase 4 — narrow the MITM URL envelope to the union of `url_patterns`
  // declared on the agent-selected tools (skipped for remote HTTP MCP).
  const toolUrlEnvelope = isRemoteHttp
    ? undefined
    : computeToolUrlEnvelope(manifest, agentToolSelection);

  // The connect-login tool is a credential-acquisition primitive, never an
  // agent-facing capability — exclude it from the allowlist so the agent's
  // LLM can never invoke it directly. (It is normally not in the selection
  // anyway, but defence-in-depth: an author could have listed it.)
  const baseAllowlist = agentToolSelection ?? [];
  const toolAllowlist = deliveries.connectLogin
    ? baseAllowlist.filter((t) => t !== deliveries.connectLogin!.toolName)
    : baseAllowlist;

  // Peer discriminant for the sidecar's spawn-mode dispatch. Mirrors
  // `source.kind`; defaults to `"api"` when the manifest didn't declare a
  // recognised source (serverless fall-back — matches the legacy behaviour
  // of leaving `server` undefined and only wiring `api_call`).
  const specSourceKind: "local" | "remote" | "api" = sourceKind ?? "api";

  return {
    integrationId,
    namespace,
    sourceKind: specSourceKind,
    manifest: {
      name: manifest.name,
      version: manifest.version,
      // Serverless integrations (`sourceKind: "api"`) omit `server` in the
      // spec — the sidecar's serverless path (no spec.manifest.server) skips
      // spawn and only wires the generic api_call tool. Local runners
      // (node|python|binary|uv, resolved from the referenced mcp-server) emit
      // `{ type, entry_point, serverPackageId }`. Remote MCP
      // (`sourceKind: "remote"`) emits `{ url, transport }` only — `server.type`
      // is intentionally absent because the spawn-mode discriminant lives on
      // `spec.sourceKind`, not in the AFPS `mcpServerTypeEnum` slot.
      ...(serverSpec
        ? {
            server: {
              ...(serverSpec.type ? { type: serverSpec.type } : {}),
              ...(serverSpec.entry_point ? { entry_point: serverSpec.entry_point } : {}),
              // AFPS — the referenced mcp-server package id, so the sidecar
              // fetches the runnable server bundle from
              // `GET /internal/mcp-server-bundle/...` (local sources only).
              ...(serverSpec.serverPackageId
                ? { serverPackageId: serverSpec.serverPackageId }
                : {}),
              // Phase 7 — propagate the remote MCP URL so the sidecar can open
              // a Streamable HTTP client against it. Mutually exclusive with
              // `entry_point` (enforced by `integrationManifestSchema`).
              ...(serverSpec.url ? { url: serverSpec.url } : {}),
              // AFPS §7.1 — `streamable-http` (default) | `sse`. Only
              // emitted on remote sources.
              ...(serverSpec.transport ? { transport: serverSpec.transport } : {}),
            },
          }
        : {}),
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
    // R8a defensive filter — surface `manifest.hidden_tools` to the
    // sidecar so the McpHost can drop them from `tools/list` at runtime,
    // independent of whether the install-time catalog resolver already
    // removed them. This guards against fixtures / direct DB writes that
    // bypass `resolveIntegrationToolCatalog`. Omitted when empty.
    ...((manifest.hidden_tools?.length ?? 0) > 0
      ? { hiddenTools: [...(manifest.hidden_tools ?? [])] }
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
    toolAllowlist,
    ...(toolUrlEnvelope !== undefined ? { toolUrlEnvelope } : {}),
    ...(deliveries.connectLogin ? { connectLogin: deliveries.connectLogin } : {}),
    ...(deliveries.fileMounts && Object.keys(deliveries.fileMounts).length > 0
      ? { fileMounts: deliveries.fileMounts }
      : {}),
  };
}

/**
 * Build the {@link IntegrationSpawnSpec.toolUrlEnvelope} from the agent's
 * tool selection × the integration manifest's `tools.{name}.url_patterns`.
 *
 * Returns `undefined` (no extra MITM URL enforcement) when:
 *  - The agent didn't restrict tools (`agentToolSelection === undefined`).
 *  - The agent restricted to an empty set (handled by toolAllowlist alone).
 *  - ANY selected tool lacks a `url_patterns` declaration — we can't
 *    safely narrow the envelope without blocking that tool's legitimate
 *    traffic, so we fall back to per-auth `authorized_uris`.
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
        const hasMethods = !!entry.methods && entry.methods.length > 0;
        merged.set(entry.pattern, {
          pattern: entry.pattern,
          anyMethod: !hasMethods,
          ...(hasMethods ? { methods: new Set(entry.methods) } : {}),
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
  /**
   * AFPS §7.6 — materialised `delivery.files.<path>` entries. Each
   * value's `{$credential.<field>}` template is rendered against the
   * decrypted credential bag, base64-encoded for the JSON wire, and ferried
   * to the sidecar where the runtime adapter writes the file with the
   * declared POSIX mode (default `0400`).
   */
  fileMounts?: NonNullable<IntegrationSpawnSpec["fileMounts"]>;
  /**
   * Set when the chosen connection's auth is `connect.tool` + `runAt:
   * "run-start"`: the sidecar mints the session at boot by running the
   * login tool with the decrypted login secret. `resolveOne` copies this
   * onto `IntegrationSpawnSpec.connectLogin`.
   */
  connectLogin?: NonNullable<IntegrationSpawnSpec["connectLogin"]>;
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
  referencedMcpServer: Awaited<ReturnType<typeof fetchMcpServerManifest>> | null,
  requiredAuthKey: string | undefined,
): Promise<ResolvedDeliveries | null> {
  const auths = (manifest.auths ?? {}) as Record<string, AfpsManifestAuth>;
  if (Object.keys(auths).length === 0) {
    // Integration declares no auth — spawn with no extra env, no MITM.
    return { spawnEnv: {} };
  }

  // Load the one connection chosen by the cascade. When the agent dep
  // pins an `auth_key` (AFPS §4.1), narrow the live-credentials
  // auto-pick to that single auth — the resolver snapshot already
  // honoured the pin, this is the parity guarantee for the no-snapshot
  // path (e.g. legacy callers that don't run the cascade upstream).
  const row = await selectAccessibleConnection(
    integrationId,
    Object.keys(auths),
    resolvedConnection?.connectionId ?? null,
    { applicationId, actor, ...(requiredAuthKey ? { requiredAuthKey } : {}) },
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

  // ─── connect.tool + run_at:"run-start" — store-the-secret acquisition ───
  // The injectable outputs plane is empty at rest: only the login secret was
  // persisted (NON-injectable `inputs`). The sidecar mints the session at
  // boot by running the integration's login tool with the decrypted secret.
  //
  // AFPS: the orchestrated-tool name + run policy live under
  // `connect._meta["dev.appstrate/connect"]` (`tool`, `run_at`, `reauth_on`,
  // `produces`); `connect.tool` itself is just the spec marker object.
  const httpDecl0 = auth.delivery?.http;
  const connectMeta = getAppstrateConnectMeta(auth.connect);
  if (
    auth.type === "custom" &&
    auth.connect?.tool !== undefined &&
    connectMeta?.tool &&
    connectMeta.run_at === "run-start"
  ) {
    if (!httpDecl0) {
      // A run-start connect.tool auth without delivery.http has nothing to
      // inject the captured session into — the manifest is mis-declared.
      logger.warn("run-start connect.tool auth has no delivery.http; skipping", {
        integrationId,
        authKey: row.authKey,
      });
      return null;
    }
    let inputs: Record<string, string>;
    try {
      inputs = decryptCredentialInputsToStringMap(row.credentialsEncrypted);
    } catch (err) {
      logger.warn("decrypt failed for run-start login secret", {
        integrationId,
        authKey: row.authKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (Object.keys(inputs).length === 0) {
      // No persisted login secret → treat as not-connected for this run.
      // Do NOT spawn a half-broken session.
      logger.info("run-start connect.tool connection has no persisted login secret; skipping", {
        integrationId,
        authKey: row.authKey,
      });
      return null;
    }
    // Placeholder MITM entry so the sidecar creates the per-integration
    // credentials source + listener. The real session header is installed at
    // boot by `runConnectLogin` (`source.setSessionOutputs`). The value is
    // intentionally empty at rest — no live session exists yet.
    const placeholderPlan = resolveAfpsHttpDelivery(
      auth.type,
      {},
      httpDecl0 as ConnectAfpsHttpDelivery,
    ) ?? {
      headerName: "",
      headerPrefix: "",
      value: "",
      allowServerOverride: false,
    };
    const authorizedUris = auth.authorized_uris ?? [];
    const httpDeliveryAuths: NonNullable<IntegrationSpawnSpec["httpDeliveryAuths"]> = {
      [row.authKey]: {
        ...placeholderPlan,
        authType: auth.type,
        authorizedUris: [...authorizedUris],
        expiresAtEpochMs: null,
      },
    };
    return {
      spawnEnv: {},
      httpDeliveryAuths,
      connectLogin: {
        toolName: connectMeta.tool,
        ...(connectMeta.produces ? { produces: connectMeta.produces } : {}),
        authKey: row.authKey,
        authType: auth.type,
        authorizedUris: [...authorizedUris],
        deliveryHttp: httpDecl0,
        inputs,
        ...(connectMeta.reauth_on ? { reauthOn: [...connectMeta.reauth_on] } : {}),
      },
    };
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
  const fileMounts: NonNullable<IntegrationSpawnSpec["fileMounts"]> = {};
  let resolvedAtLeastOne = false;

  // ─── delivery.env ───
  // AFPS: each entry carries a `{$credential.<field>}` value template
  // (was the 1.x `{ from }` field pointer). Render it against the credential bag.
  //
  // AFPS §7.6 (CC-4): for local-source integrations whose referenced
  // mcp-server declares `${user_config.<key>}` placeholders in
  // `server.mcp_config.env`, the entry's `user_config_key` (defaulting to the
  // env-variable name) names the placeholder we pre-render. The substituted
  // env then flows to the sidecar exactly as if it had come from a standalone
  // MCPB host — one package, two environments.
  const envMap = auth.delivery?.env;
  const userConfigSubstitutions: Record<string, string> = {};
  if (envMap && Object.keys(envMap).length > 0) {
    for (const [envKey, conf] of Object.entries(envMap)) {
      const value = renderCredentialTemplate(conf.value, fields);
      if (value === null) {
        logger.info("delivery.env value template resolved empty on credentials", {
          integrationId,
          authKey: row.authKey,
          envKey,
        });
        continue;
      }
      spawnEnv[envKey] = value;
      // AFPS §7.6: collect the user_config bridge entries. Default
      // `user_config_key` to the env-variable name when omitted.
      const userConfigKey = conf.user_config_key ?? envKey;
      userConfigSubstitutions[userConfigKey] = value;
      resolvedAtLeastOne = true;
    }
  }

  // AFPS §7.6 + §3.4 (CC-4) — bridge into the referenced mcp-server's
  // `mcp_config.env` template. Each `${user_config.<key>}` placeholder is
  // replaced with the rendered credential value the integration's
  // `delivery.env` materialised under that key. Keys without a matching
  // substitution pass through verbatim (the placeholder reaches the runner
  // unsubstituted — the runner is responsible for raising a clear error).
  //
  // The rendered map is MERGED into `spawnEnv`. The integration's own
  // `delivery.env` keys win on conflict — the integration is the
  // authoritative source for what its server sees.
  if (referencedMcpServer && Object.keys(userConfigSubstitutions).length > 0) {
    const mcpConfigEnv = getMcpServerMcpConfigEnv(referencedMcpServer);
    if (mcpConfigEnv && Object.keys(mcpConfigEnv).length > 0) {
      const rendered = renderMcpConfigEnv(mcpConfigEnv, userConfigSubstitutions);
      for (const [k, v] of Object.entries(rendered)) {
        // Integration's direct delivery.env wins — don't shadow it.
        if (k in spawnEnv) continue;
        spawnEnv[k] = v;
      }
    }
  }

  // ─── delivery.files (AFPS §7.6, CC-5) ───
  // Each entry's `value` is a `{$credential.<field>}` template rendered
  // against the credential bag (same grammar as `delivery.env`); `mode` is
  // an octal-string POSIX permission (default `0400`). Used primarily for
  // mtls (client cert + key) but available for any auth whose credential
  // is file-shaped.
  //
  // Security: path keys MUST be absolute POSIX, MUST NOT contain `..`, MUST
  // NOT collapse to `/`. Unsafe paths are skipped with a warning rather
  // than aborting the integration — operator error in one path shouldn't
  // black-hole a multi-file mtls bundle.
  const filesMap = auth.delivery?.files;
  if (filesMap && Object.keys(filesMap).length > 0) {
    for (const [path, conf] of Object.entries(filesMap)) {
      if (!isSafeDeliveryFilePath(path)) {
        logger.warn("delivery.files path rejected by safety guard; skipping entry", {
          integrationId,
          authKey: row.authKey,
          path,
        });
        continue;
      }
      const value = renderCredentialTemplate(conf.value, fields);
      if (value === null) {
        logger.info("delivery.files value template resolved empty on credentials", {
          integrationId,
          authKey: row.authKey,
          path,
        });
        continue;
      }
      // Parse + normalise mode. Manifest authors typically write `"0400"`,
      // `"0600"`, etc. — reject malformed strings rather than silently
      // applying a too-permissive default.
      let mode = DEFAULT_DELIVERY_FILE_MODE;
      if (conf.mode !== undefined) {
        const parsed = parseFileMode(conf.mode);
        if (parsed === null) {
          logger.warn("delivery.files mode unparseable; using default 0400", {
            integrationId,
            authKey: row.authKey,
            path,
            rawMode: conf.mode,
          });
        } else {
          mode = parsed;
        }
      }
      // Base64-encode the rendered bytes for the JSON wire. Use Bun's
      // `Buffer.from(...).toString("base64")` — Bun ships Node's Buffer
      // compat layer so this is fine in Bun, Node, and the test runner.
      const content_b64 = Buffer.from(value, "utf8").toString("base64");
      fileMounts[path] = { content_b64, mode };
      resolvedAtLeastOne = true;
    }
  }

  // ─── delivery.http (Phase 1.5) ───
  const httpDecl = auth.delivery?.http;
  if (httpDecl) {
    const plan = resolveAfpsHttpDelivery(auth.type, fields, httpDecl as ConnectAfpsHttpDelivery);
    if (!plan) {
      logger.info("delivery.http produced no plan (auth missing required fields)", {
        integrationId,
        authKey: row.authKey,
        authType: auth.type,
      });
    } else {
      // A plan with a header name but an empty value is a silent-no-op trap:
      // the MITM planner drops empty-value injections, so the credential header
      // is never injected and upstream calls go out unauthenticated while the
      // run still "succeeds". This happens when `delivery.http.valueFrom` names
      // a credential field that is absent on the stored connection — typically a
      // key-casing mismatch (e.g. `apiKey` stored vs `api_key` declared). Surface
      // it loudly instead of letting it pass unnoticed. (`basic` builds its value
      // from username:password, so an empty value there is the same defect.)
      if (plan.headerName.length > 0 && plan.value.length === 0) {
        logger.warn(
          "delivery.http resolved an empty credential value — header will NOT be injected " +
            "(credential field missing/empty on the connection; check for a key-casing mismatch " +
            "against the manifest's credentials.schema)",
          {
            integrationId,
            authKey: row.authKey,
            authType: auth.type,
            connectionId: row.id,
            headerName: plan.headerName,
            valueTemplate: httpDecl.value ?? "<default>",
            storedFieldKeys: Object.keys(fields),
          },
        );
      }
      httpDeliveryAuths[row.authKey] = {
        ...plan,
        authType: auth.type,
        authorizedUris: [...(auth.authorized_uris ?? [])],
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
    ...(Object.keys(fileMounts).length > 0 ? { fileMounts } : {}),
  };
}
