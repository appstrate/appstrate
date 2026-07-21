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
  canonicalizeApiToolName,
  getApiCallConfigs,
  resolveEffectiveToolSelection,
} from "@appstrate/core/integration";
import type {
  IntegrationManifest,
  ResolvedConnection,
  ResolvedConnectionMap,
} from "@appstrate/core/integration";
// ResolvedConnectionMap is consumed via input prop (`resolvedConnections`) below.
import { isToolsWildcard, parseManifestIntegrations } from "@appstrate/core/dependencies";
import {
  getMcpServerMcpConfigEnv,
  renderMcpConfigEnv,
  type McpServerManifest,
} from "@appstrate/core/mcp-server";
import type {
  IntegrationSpawnSpec,
  ApiCallSpec,
  BrowserExecutionSpec,
} from "@appstrate/core/sidecar-types";

import { BundleError } from "@appstrate/afps-runtime/bundle";
import { checkEgressUrl } from "../lib/egress-host-guard.ts";
import { logger } from "../lib/logger.ts";
import type { Actor } from "../lib/actor.ts";
import { isIntegrationActive, selectAccessibleConnection } from "./integration-connections.ts";
import { fetchIntegrationManifest, type IntegrationManifestCache } from "./integration-service.ts";
import { resolveLocalMcpServerExecution } from "./resolved-mcp-server-execution.ts";
import { BrowserCapabilityPolicyError } from "./browser-capability-grants.ts";
import { getBrowserProviderBinding } from "./browser-connection-state.ts";
import {
  getIntegrationSourceKind,
  getLocalServerRef,
  getRemoteSource,
  getAppstrateConnectMeta,
  getBrowserConnectExecutor,
  renderCredentialTemplate,
  parseFileMode,
  isSafeDeliveryFilePath,
  DEFAULT_DELIVERY_FILE_MODE,
  type AfpsManifestAuth,
} from "./integration-manifest-helpers.ts";

export interface ResolveIntegrationsInput {
  /**
   * The run's org — required tenant boundary for package resolution
   * (defense in depth against a cross-tenant reference): a spawn may only
   * resolve packages the org owns or system packages.
   */
  orgId: string;
  applicationId: string;
  /** The actor whose connections to lookup — `null` skips integration resolution entirely. */
  actor: Actor | null;
  /**
   * The agent's full manifest. Versions come from
   * `dependencies.integrations` (§4.1), tool/scope selections from the
   * top-level `integrations_configuration` block (§4.4, niveau 2 scope
   * model). The resolver propagates the per-id `tools[]` to
   * `IntegrationSpawnSpec.toolAllowlist` for sidecar-side enforcement (Phase 3).
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
  /**
   * Per-call-graph memo for integration manifest fetches — threaded from the
   * run kickoff path (readiness → snapshot → here) so each integration's
   * manifest is SELECTed + Zod-parsed once per run trigger.
   */
  manifestCache?: IntegrationManifestCache;
}

/**
 * Compute the two independent agent-surface filters for credential-acquisition
 * tools. The sidecar may still call the raw upstream client by name, but the
 * agent must neither list nor invoke these tools through McpHost.
 */
export function privateConnectToolExposure(input: {
  wildcardSelection: boolean;
  effectiveSelection: readonly string[];
  manifestHiddenTools: readonly string[];
  privateToolNames: readonly (string | undefined)[];
}): { toolAllowlist: readonly string[] | undefined; hiddenTools: string[] } {
  const privateTools = new Set(
    input.privateToolNames.filter(
      (name): name is string => typeof name === "string" && name !== "",
    ),
  );
  const hiddenTools = [...new Set([...input.manifestHiddenTools, ...privateTools])];
  return {
    toolAllowlist: input.wildcardSelection
      ? undefined
      : input.effectiveSelection.filter((tool) => !privateTools.has(tool)),
    hiddenTools,
  };
}

/**
 * Return one `IntegrationSpawnSpec` per integration that's (a) declared
 * on the agent, (b) installed in the application, AND (c) connected by
 * the actor. Other integrations are dropped with a warning.
 */
export async function resolveIntegrationSpawns(
  input: ResolveIntegrationsInput,
): Promise<IntegrationSpawnSpec[]> {
  const { orgId, applicationId, actor, agentManifest, resolvedConnections } = input;
  // No actor → no actor-scoped connections to resolve. Scheduled runs are
  // fail-fasted upstream when actor-less + integrations are declared (#735,
  // scheduler.ts `scheduleCannotResolveIntegrations`); request-triggered runs
  // always carry an actor (`getActor` is non-null), so this stays an empty
  // return rather than a throw.
  if (!actor) return [];

  const entries = parseManifestIntegrations(agentManifest);
  if (entries.length === 0) return [];
  // Resolve every declared integration concurrently — each resolution is an
  // independent chain of DB reads + storage fetch + credential decrypt, and
  // the sequential version paid their latencies back-to-back on the run
  // kickoff critical path. Declaration order is preserved by mapping then
  // compacting.
  const specs = await Promise.all(
    entries.map(async (entry) => {
      try {
        return await resolveOne(
          entry.id,
          orgId,
          applicationId,
          actor,
          entry.tools,
          resolvedConnections?.[entry.id] ?? null,
          entry.auth_key,
          input.manifestCache,
        );
      } catch (err) {
        // An unsatisfiable referenced-mcp-server pin is a hard failure: the run
        // must NOT silently spawn without the integration's tools. resolveOne
        // raises a DEPENDENCY_UNRESOLVED BundleError for it; let it propagate so
        // the pipeline maps it to a structured 422 (#686), matching the skill
        // closure (#666). Every other failure (not installed / not connected /
        // missing referenced package) stays a per-integration warn-and-skip.
        if (
          (err instanceof BundleError && err.code === "DEPENDENCY_UNRESOLVED") ||
          err instanceof BrowserCapabilityPolicyError
        ) {
          throw err;
        }
        logger.warn("integration resolve failed; skipping", {
          integrationId: entry.id,
          applicationId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }),
  );
  let browserSlot = 0;
  return specs
    .filter((s): s is IntegrationSpawnSpec => s !== null)
    .map((spec) =>
      spec.browser ? { ...spec, browser: { ...spec.browser, isolationSlot: browserSlot++ } } : spec,
    );
}

async function resolveOne(
  integrationId: string,
  orgId: string,
  applicationId: string,
  actor: Actor,
  agentToolSelection: readonly string[] | "*" | undefined,
  resolvedConnection: ResolvedConnection | null,
  requiredAuthKey: string | undefined,
  manifestCache?: IntegrationManifestCache,
): Promise<IntegrationSpawnSpec | null> {
  // (a) Package exists + integration type. The manifest is read through the
  // per-run `manifestCache`, which `resolveRunIntegrationVersions` seeds at
  // kickoff (#686) with the manifest AT the version the
  // `dependencies.integrations.<id>` pin resolved to (published / system /
  // draft-override). So this read honors the pin transparently; only when no
  // entry was seeded (soft-resolved or non-run callers) does it fall back to
  // `packages.draft_manifest`. An unsatisfiable integration pin already failed
  // the run loud upstream, before we get here.
  const res = await fetchIntegrationManifest(integrationId, manifestCache);
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

  // Resolve the EFFECTIVE tool selection: the agent's explicit selection wins
  // (including `[]` "zero tools" and `"*"` wildcard); only an unspecified
  // selection (`undefined`) falls back to the integration's declared
  // `default_tools` (AFPS §4.4). Computed once here and used for both the
  // api_call filter (below) and the sidecar `toolAllowlist` (Phase 3) so the
  // default is honoured identically on both paths.
  const effectiveSelection = resolveEffectiveToolSelection(agentToolSelection, manifest);

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
  // api_call is the generic credential-injecting tool, declared via the
  // `_meta["dev.appstrate/api"]` vendor extension (orthogonal to source kind —
  // a `local`/`remote`/`none` integration may all expose it). Each opted-in
  // auth yields one tool; we keep only the ones the agent actually selected
  // (least-privilege: the catch-all tool is never auto-granted). `authorized_uris`
  // come from each api_call auth.
  // AFPS §4.4 wildcard — when the agent opted into all upstream tools, the
  // synthetic api_call tool(s) are auto-granted alongside the upstream surface.
  // Otherwise filter to what the agent explicitly picked.
  //
  // `api_call` and its `api_upload` companion are granted as a pair: the upload
  // orchestration dispatches every chunk through the sibling api_call tool, so
  // selecting one without the other would either expose a broken upload tool or
  // silently drop a selected capability. Picking either name grants both.
  const wildcardSelection = isToolsWildcard(effectiveSelection);
  const selectedTools = wildcardSelection ? null : new Set(effectiveSelection ?? []);
  const apiCalls: ApiCallSpec[] = getApiCallConfigs(manifest)
    .filter(
      (cfg) =>
        wildcardSelection ||
        selectedTools!.has(cfg.toolName) ||
        (cfg.legacyToolName !== undefined && selectedTools!.has(cfg.legacyToolName)) ||
        (cfg.uploadToolName !== undefined && selectedTools!.has(cfg.uploadToolName)) ||
        (cfg.legacyUploadToolName !== undefined && selectedTools!.has(cfg.legacyUploadToolName)),
    )
    .map((cfg) => {
      const auth = manifest.auths?.[cfg.authKey] as AfpsManifestAuth | undefined;
      return {
        authKey: cfg.authKey,
        toolName: cfg.toolName,
        authorizedUris: [...(auth?.authorized_uris ?? [])],
        ...(auth?.allow_all_uris ? { allowAllUris: true } : {}),
        ...(cfg.uploadProtocols.length > 0 ? { uploadProtocols: cfg.uploadProtocols } : {}),
      } satisfies ApiCallSpec;
    });
  const exposeApiCall = apiCalls.length > 0;

  // ── Resolve the sidecar server spec from the AFPS `source`
  // discriminant (replaces the 1.x inline `manifest.server`). ──
  //   - remote → Streamable HTTP MCP (`{ url, transport }`; spawn-mode is
  //              selected by `spec.sourceKind`, not `server.type`).
  //   - local  → resolve the referenced mcp-server package's MCPB manifest
  //              and emit `{ type, entry_point }` from `server.{type, entry_point}`.
  //   - none   → serverless (no `server` in the spec; sidecar skips spawn).
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
        packageId?: string;
        version?: string;
        vendored?: boolean;
      }
    | undefined;
  let referencedMcpServer: McpServerManifest | null = null;
  let browser: BrowserExecutionSpec | undefined;
  let workspaceMount: IntegrationSpawnSpec["workspaceMount"];
  if (isRemoteHttp) {
    const remote = getRemoteSource(manifest);
    if (!remote) {
      logger.warn("remote-source integration missing remote.url; skipping", { integrationId });
      return null;
    }
    // P0-2 — SSRF floor on the manifest-supplied remote MCP URL. The sidecar
    // opens a credential-bearing Streamable HTTP / SSE client against this URL,
    // so validate it here (install/boot resolution) before it reaches the wire.
    // Route it through the canonical egress guard with the remote-MCP scheme
    // tier (`requireHttpsForUntrustedHost`): an operator-trusted internal host
    // may use plain http (LAN services routinely lack TLS), every other host
    // must be https AND pass the DNS-aware SSRF gate (private / loopback /
    // link-local / cloud-metadata → blocked; DNS-rebind-safe, fails closed) —
    // one shared decision site, so this resolver can't drift from the other
    // egress paths. A malformed / wrong-scheme / blocked URL throws a clear
    // error; the caller (`resolveIntegrationSpawns`) turns it into a logged
    // per-integration skip, so the run never spawns an unguarded MCP client.
    const egress = await checkEgressUrl(remote.url, { requireHttpsForUntrustedHost: true });
    if (!egress.ok) {
      if (egress.reason === "invalid-url") {
        throw new Error(
          `remote-source integration '${integrationId}' declares an invalid source.remote.url`,
        );
      }
      if (egress.reason === "blocked-scheme") {
        throw new Error(
          `remote-source integration '${integrationId}' declares a disallowed source.remote.url scheme (only https://, or http:// for an operator-trusted internal host)`,
        );
      }
      throw new Error(
        `remote-source integration '${integrationId}' source.remote.url host '${egress.hostname}' is blocked by the SSRF guard (${egress.detail})`,
      );
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
    // Resolve the referenced mcp-server to ONE concrete version, honoring the
    // `source.server.version` pin, and read THAT version's manifest. The
    // resolved `version` is forwarded to the byte route (below, via
    // `server.version`) so the runnable bytes come from the same version — no
    // manifest/bytes skew, and a `publish` is reflected on the run without a
    // draft overwrite (issue #588). An unsatisfiable pin / missing published
    // version skips the integration LOUDLY rather than silently falling back to
    // whatever bytes happen to be latest.
    const resolution = await resolveLocalMcpServerExecution({
      packageId: ref.name,
      orgId,
      pin: ref.version,
    });
    if (!resolution.ok) {
      // A real `source.server.version` pin that cannot be met (unsatisfiable
      // range / never-published) fails the run LOUDLY (#686) — a pinned run
      // must never silently spawn without the integration. A
      // missing/wrong/invalid referenced package stays a soft skip: the
      // integration is mis-declared, not the run's pin, so the run proceeds
      // without it (the sidecar surfaces the gap from its side too).
      if (
        resolution.reason === "unsatisfiable_pin" ||
        resolution.reason === "no_published_version"
      ) {
        throw new BundleError(
          "DEPENDENCY_UNRESOLVED",
          `Referenced mcp-server '${ref.name}@${ref.version ?? "latest"}' could not be resolved against published versions (${resolution.reason})`,
          { missing: [{ name: ref.name, versionSpec: ref.version ?? "latest" }] },
        );
      }
      logger.warn("referenced mcp-server could not be resolved; skipping integration", {
        integrationId,
        mcpServerId: ref.name,
        pin: ref.version,
        reason: resolution.reason,
      });
      return null;
    }
    const resolvedServer = resolution.execution;
    const mcpServer = resolvedServer.manifest;
    referencedMcpServer = mcpServer;
    browser = resolvedServer.browser;
    workspaceMount = resolvedServer.workspaceMount;
    // AFPS §7.1 — propagate `source.server.vendored` build-provenance signal
    // through the spawn spec → boot report so operators can audit "this run
    // used a vendored foreign package". Only meaningful for local sources.
    serverSpec = {
      type: resolvedServer.runtime,
      entry_point: resolvedServer.entryPoint,
      packageId: ref.name,
      // The version the byte route must serve. `null` for system mcp-servers
      // (the boot registry holds a single version, fetched by id alone).
      ...(resolvedServer.source === "version" ? { version: resolvedServer.version } : {}),
      ...(typeof ref.vendored === "boolean" ? { vendored: ref.vendored } : {}),
    };
  }
  // sourceKind === "none" (or unknown) → serverless, serverSpec stays undefined.

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

  if (deliveries.browserConnect) {
    if (!browser || browser.purpose !== "connection-acquisition" || !browser.trustedDriver) {
      throw new BrowserCapabilityPolicyError(
        `Integration '${integrationId}' selects the browser connect executor but its resolved mcp-server is not an authorized connection-acquisition driver`,
      );
    }
    const providerBinding = deliveries.connectionId
      ? await getBrowserProviderBinding(deliveries.connectionId)
      : null;
    browser = {
      ...browser,
      sessionMode: deliveries.browserConnect.sessionMode,
      connectionId: deliveries.connectionId,
      ...(providerBinding ? { providerBinding } : {}),
    };
  }

  // Namespace = the manifest name's slug portion, normalised by the
  // MCP host. We pass the package id; McpHost.normaliseNamespace does
  // the slug + length cap.
  const namespace = integrationId;

  // Canonicalize manifest-hidden names first, then apply the single policy
  // kernel that removes every private connect hook from both agent-facing
  // surfaces: the selection allowlist and the sidecar's defensive hidden set.
  const manifestHiddenTools: string[] = [...(manifest.hidden_tools ?? [])];
  for (const name of manifest.hidden_tools ?? []) {
    const canonical = canonicalizeApiToolName(manifest, name);
    if (!manifestHiddenTools.includes(canonical)) manifestHiddenTools.push(canonical);
  }
  const { toolAllowlist, hiddenTools: hiddenToolsUnion } = privateConnectToolExposure({
    wildcardSelection,
    effectiveSelection: wildcardSelection ? [] : ((effectiveSelection ?? []) as readonly string[]),
    manifestHiddenTools,
    privateToolNames: [deliveries.connectLogin?.toolName, deliveries.browserConnect?.toolName],
  });

  // Peer discriminant for the sidecar's spawn-mode dispatch. Mirrors
  // `source.kind`; defaults to `"none"` when the manifest didn't declare a
  // recognised source (serverless fall-back — the sidecar skips spawn and
  // wires only the api_call tool(s), if any).
  const specSourceKind: "local" | "remote" | "none" = sourceKind ?? "none";

  return {
    integrationId,
    namespace,
    sourceKind: specSourceKind,
    manifest: {
      name: manifest.name,
      version: manifest.version,
      // Serverless integrations (`sourceKind: "none"`) omit `server` in the
      // spec — the sidecar's serverless path (no spec.manifest.server) skips
      // spawn and only wires the generic api_call tool. Local runners
      // (node|python|binary|uv, resolved from the referenced mcp-server) emit
      // `{ type, entry_point, packageId, version }`. Remote MCP
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
              ...(serverSpec.packageId ? { packageId: serverSpec.packageId } : {}),
              // #588 — the concrete resolved version, so the sidecar fetches
              // `?version=…` and the bytes match the manifest read above.
              ...(serverSpec.version ? { version: serverSpec.version } : {}),
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
    ...(apiCalls.length > 0 ? { apiCalls } : {}),
    // R8a defensive filter — surface `manifest.hidden_tools` to the
    // sidecar so the McpHost can drop them from `tools/list` at runtime,
    // independent of whether the install-time catalog resolver already
    // removed them. This guards against fixtures / direct DB writes that
    // bypass `resolveIntegrationToolCatalog`. Under the wildcard branch
    // we also union in every connect tool name so the agent's LLM can never
    // see a credential-acquisition primitive. Omitted when both sources are
    // empty.
    ...(hiddenToolsUnion.length > 0 ? { hiddenTools: hiddenToolsUnion } : {}),
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
    //
    // AFPS §4.4 wildcard — `toolAllowlist === undefined` instructs the
    // sidecar (via the conditional spread below) to omit the field, which
    // McpHost interprets as "all tools allowed" (legacy passthrough).
    ...(toolAllowlist !== undefined ? { toolAllowlist } : {}),
    ...(deliveries.connectLogin ? { connectLogin: deliveries.connectLogin } : {}),
    ...(deliveries.browserConnect ? { browserConnect: deliveries.browserConnect } : {}),
    ...(browser ? { browser } : {}),
    ...(deliveries.fileMounts && Object.keys(deliveries.fileMounts).length > 0
      ? { fileMounts: deliveries.fileMounts }
      : {}),
    // Issue #543 — explicit egress signal for no-injection local runners.
    // The sidecar mounts a plain CONNECT egress listener when this is set and
    // no injection plan exists. Dropped for remote HTTP (no runner to route).
    ...(deliveries.needsEgress && !isRemoteHttp ? { needsEgress: true } : {}),
    // Opt-in shared workspace mount declared on the referenced
    // mcp-server. Only emitted for local sources — remote and
    // serverless integrations have no runner container/process to
    // mount into. A malformed `_meta` throws synchronously here so a
    // bad manifest fails fast at run kickoff rather than producing a
    // silently-degraded spawn that the operator can't diagnose.
    ...(workspaceMount && specSourceKind === "local" ? { workspaceMount } : {}),
  };
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
  browserConnect?: NonNullable<IntegrationSpawnSpec["browserConnect"]>;
  connectionId?: string;
  /**
   * Issue #543 — `true` when this local-source runner needs a controlled
   * egress route but no header injection (a `delivery.env` auth that declares
   * an outbound surface). The sidecar mounts a plain CONNECT egress listener
   * for it. Never set for `mtls` (reaches upstream directly) or non-local
   * sources. `resolveOne` copies this onto `IntegrationSpawnSpec.needsEgress`.
   */
  needsEgress?: boolean;
}

/**
 * An exportable run-start browser session is installed only after the driver
 * has started, so env/files delivery cannot be mutated in place. A blank HTTP
 * plan forces the sidecar to create the shared credential source + MITM
 * listener before acquisition; `runBrowserConnect` then replaces its value
 * atomically with the proven session for all subsequent native tool calls.
 */
export function buildBrowserRunStartHttpPlaceholder(input: {
  authKey: string;
  authType: string;
  authorizedUris: readonly string[];
  deliveryHttp: ConnectAfpsHttpDelivery;
}): NonNullable<IntegrationSpawnSpec["httpDeliveryAuths"]> {
  const placeholderPlan = resolveAfpsHttpDelivery(input.authType, {}, input.deliveryHttp) ?? {
    headerName: "",
    headerPrefix: "",
    value: "",
    allowServerOverride: false,
  };
  return {
    [input.authKey]: {
      ...placeholderPlan,
      authType: input.authType,
      authorizedUris: [...input.authorizedUris],
      expiresAtEpochMs: null,
    },
  };
}

export function selectPersistedBrowserState(
  fields: Readonly<Record<string, string>>,
  produces: readonly string[],
): Record<string, string> | null {
  const selected: Record<string, string> = {};
  for (const field of produces) {
    const value = fields[field];
    if (typeof value === "string" && value.length > 0) selected[field] = value;
  }
  return Object.keys(selected).length > 0 ? selected : null;
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
  referencedMcpServer: McpServerManifest | null,
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
  const browserExecutor = getBrowserConnectExecutor(auth.connect);
  if (
    auth.type === "custom" &&
    auth.connect?.tool !== undefined &&
    connectMeta?.tool &&
    connectMeta.run_at === "run-start"
  ) {
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
    if (browserExecutor) {
      const produces = connectMeta.produces ?? [];
      if (browserExecutor.session_mode === "exportable" && produces.length === 0) {
        logger.warn("exportable browser connect declares no outputs; skipping", {
          integrationId,
          authKey: row.authKey,
        });
        return null;
      }
      if (browserExecutor.session_mode === "exportable" && !httpDecl0) {
        // The driver starts before the session exists, so delivery.env/files
        // cannot be updated for this run. Link-time export can persist those
        // channels, but run-start export currently requires HTTP injection.
        logger.warn("run-start exportable browser auth has no delivery.http; skipping", {
          integrationId,
          authKey: row.authKey,
        });
        return null;
      }
      const authorizedUris = [...(auth.authorized_uris ?? [])];
      return {
        spawnEnv: {},
        connectionId: row.id,
        ...(browserExecutor.session_mode === "exportable" && httpDecl0
          ? {
              httpDeliveryAuths: buildBrowserRunStartHttpPlaceholder({
                authKey: row.authKey,
                authType: auth.type,
                authorizedUris,
                deliveryHttp: httpDecl0 as ConnectAfpsHttpDelivery,
              }),
            }
          : {}),
        browserConnect: {
          toolName: connectMeta.tool,
          produces: [...produces],
          authKey: row.authKey,
          authType: auth.type,
          authorizedUris,
          sessionMode: browserExecutor.session_mode,
          inputs,
          deliveryHttp: httpDecl0,
        },
      };
    }

    if (!httpDecl0) {
      // A regular run-start connect.tool auth without delivery.http has
      // nothing to inject the captured session into. Browser-bound acquisition
      // is handled above and deliberately does not need this channel.
      logger.warn("run-start connect.tool auth has no delivery.http; skipping", {
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

  // Link-time exportable browser connections persist an encrypted, driver-owned
  // storage-state blob rather than a cookie/header credential. Rehydrate that
  // state into a fresh isolated browser at run boot through the same private
  // sidecar→trusted-driver channel used for acquisition. The blob never enters
  // runner env, argv, logs, delivery templates, or the agent-visible surface.
  if (
    auth.type === "custom" &&
    auth.connect?.tool !== undefined &&
    connectMeta?.tool &&
    connectMeta.run_at !== "run-start" &&
    browserExecutor?.session_mode === "exportable"
  ) {
    const produces = connectMeta.produces ?? [];
    const browserState = selectPersistedBrowserState(fields, produces);
    if (!browserState) {
      logger.warn("exportable browser connection has no restorable state; skipping", {
        integrationId,
        authKey: row.authKey,
        connectionId: row.id,
      });
      return null;
    }
    return {
      spawnEnv: {},
      connectionId: row.id,
      browserConnect: {
        toolName: connectMeta.tool,
        produces: [...produces],
        authKey: row.authKey,
        authType: auth.type,
        authorizedUris: [...(auth.authorized_uris ?? [])],
        sessionMode: "exportable",
        inputs: browserState,
      },
    };
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

  // ─── egress signal for local runners (decoupled from injection, #543) ───
  // A local-source runner sits on the per-run network (`internal: true` in
  // docker mode) with NO direct egress; its only route out is a
  // per-integration listener the sidecar mounts and hands it as `HTTPS_PROXY`.
  //
  // Egress and credential injection are orthogonal concerns. A `delivery.http`
  // integration gets its egress route from the MITM listener its injection
  // plan (`httpDeliveryAuths`) already mounts. A `delivery.env` integration
  // (the server authenticates itself, e.g. a form/session login) resolves NO
  // injection plan — so we raise an explicit `needsEgress` flag and the
  // sidecar mounts a plain CONNECT egress listener for it (tunnel + SSRF
  // floor, NO TLS termination, NO cert mint). The env credentials are
  // delivered separately via `spawnEnv`.
  //
  // NEVER for `mtls`: routing a client-cert handshake through a proxy that
  // terminates TLS would break it (same reason `mtls + delivery.http` is
  // rejected at install) — `delivery.files`/mtls runners reach upstream
  // directly. We set the flag for any non-mtls local runner that declares an
  // outbound surface; when an http injection plan is ALSO present the sidecar
  // picks the MITM listener (which already provides egress) — `needsEgress`
  // is the fallback, decided MITM-first in `integrations-boot.ts`.
  //
  // Scope note: the egress listener is NOT an `authorized_uris` allowlist
  // today — it forwards to any external host and only hard-blocks
  // internal/cloud-metadata targets (SSRF floor). Turning `authorized_uris`
  // into a hard per-integration egress allowlist is a separate, deliberate
  // security decision (see #543); the listener seam accepts it when we choose.
  const isLocalSource = getIntegrationSourceKind(manifest) === "local";
  const declaresEgress = (auth.authorized_uris?.length ?? 0) > 0 || auth.allow_all_uris === true;
  const needsEgress = isLocalSource && resolvedAtLeastOne && auth.type !== "mtls" && declaresEgress;

  // apiCall integrations stay viable on a resolved connection alone — a
  // `custom` auth resolves no delivery plan but the credential fields are
  // still served (for {{var}} substitution) via the live endpoint.
  if (!resolvedAtLeastOne && !hasApiCall) return null;
  return {
    spawnEnv,
    ...(Object.keys(httpDeliveryAuths).length > 0 ? { httpDeliveryAuths } : {}),
    ...(Object.keys(fileMounts).length > 0 ? { fileMounts } : {}),
    ...(needsEgress ? { needsEgress: true } : {}),
  };
}
