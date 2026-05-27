// SPDX-License-Identifier: Apache-2.0

/**
 * P4 — the production {@link ConnectToolExecutor} binding: the ephemeral
 * connect-run substrate for `runAt: "link"` connect.tool auths.
 *
 * At dashboard "Connect" (and on out-of-run re-bootstrap), the
 * {@link OrchestratedStrategy} hands one {@link ConnectToolExecution} to this
 * executor's `run(...)`. The executor:
 *
 *   1. mints a connect-run id + run-token,
 *   2. builds a single {@link IntegrationSpawnSpec} carrying a `connectLogin`
 *      block derived from the execution's manifest auth,
 *   3. launches a STRIPPED sidecar (isolation boundary + sidecar, NO agent
 *      container) in connect mode via {@link ContainerOrchestrator.createSidecar}
 *      with `connectLoginSpec` set,
 *   4. captures the sidecar's stdout, parses the `APPSTRATE_CONNECT_RESULT:` /
 *      `APPSTRATE_CONNECT_ERROR:` sentinel into a {@link CredentialBundle} (or a
 *      thrown error),
 *   5. tears down (sidecar + boundary) in a `finally`, exactly like
 *      `runPlatformContainer`'s cleanup order — even on error / timeout.
 *
 * It reuses the existing run-launch machinery (orchestrator + sidecar) — it
 * does NOT reimplement spawning. The captured bundle is returned to the
 * OrchestratedStrategy, which persists it (incl. the login secret when
 * `persistLoginSecret`).
 *
 * Security: the login secret travels in `connectLogin.inputs` inside
 * `CONNECT_LOGIN_JSON` (same trust level as `spawnEnv`) and is substituted
 * proxy-side by the sidecar's MITM — never handed to tool code, never logged.
 * The bundle returns on the sidecar's sentinel stdout line, which the parser
 * below extracts without logging the values.
 */

import { randomBytes } from "node:crypto";

import { logger } from "../../lib/logger.ts";
import { signRunToken } from "../../lib/run-token.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { fetchMcpServerManifest } from "../integration-service.ts";
import {
  getIntegrationSourceKind,
  getLocalServerRef,
  getAppstrateConnectMeta,
  type AfpsManifestAuth,
} from "../integration-manifest-helpers.ts";
import {
  getOrchestrator,
  type ContainerOrchestrator,
  type IsolationBoundary,
  type WorkloadHandle,
} from "../orchestrator/index.ts";
import type { ConnectToolExecution, ConnectToolExecutor } from "./orchestrated-strategy.ts";
import type { CredentialBundle } from "./strategy.ts";

const RESULT_SENTINEL = "APPSTRATE_CONNECT_RESULT:";
const ERROR_SENTINEL = "APPSTRATE_CONNECT_ERROR:";

/**
 * Coerce a credential bag's values to strings. The sidecar's MITM substitutes
 * `{{name}}` placeholders only on strings (a URL or header value template
 * has no notion of "substitute a number"), so non-string credential values
 * are JSON-stringified at this boundary. The route layer's
 * `connectFieldsSchema` accepts JSON-typed credentials per JSON Schema
 * 2020-12 §7.5; this is where they get serialized for the wire-level
 * substitution contract.
 */
function stringifyInputs(inputs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

/** How long to wait for the connect-run sidecar to mint the session before killing it. */
const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

export interface ConnectRunExecutorOptions {
  /** Injectable orchestrator — production defaults to the global singleton. */
  orchestrator?: ContainerOrchestrator;
  /** Override the connect-run timeout (ms). Defaults to 60s. */
  timeoutMs?: number;
  /**
   * Injectable mcp-server resolver (local-source server lookup). Production
   * defaults to the package-store lookup; unit tests supply a fixture.
   */
  resolveMcpServer?: McpServerResolver;
}

/**
 * Build the single {@link IntegrationSpawnSpec} the connect-run sidecar boots.
 * Derives the spawn spec's TS-internal `authType` / `authorizedUris` /
 * `deliveryHttp` fields from the execution's manifest auth — the same fields
 * the spawn resolver emits for the run-start path. These names are
 * TS-internal (camelCase per the documented Zone 3 carve-out); the
 * snake_case-on-wire mapping (`authorized_uris`, `delivery.http`) happens at
 * serialization. Throws (mapped onto a structured strategy error) when the
 * manifest auth is mis-declared (missing auth or `delivery.http`).
 */
/**
 * Resolver for the mcp-server MCPB manifest a local-source integration
 * references (`source.server.name`). Injectable so unit tests can supply a
 * fixture without a DB; production defaults to the package-store lookup.
 */
export type McpServerResolver = (
  packageId: string,
) => Promise<{ server?: { type?: string; entry_point?: string } } | null>;

export async function buildConnectLoginSpec(
  execution: ConnectToolExecution,
  resolveMcpServer: McpServerResolver = fetchMcpServerManifest,
): Promise<IntegrationSpawnSpec> {
  const auths = (execution.manifest.auths ?? {}) as Record<string, AfpsManifestAuth>;
  const auth = auths[execution.authKey];
  if (!auth) {
    throw new Error(
      `connect-run: auth '${execution.authKey}' not declared on '${execution.integrationId}'`,
    );
  }
  const deliveryHttp = auth.delivery?.http;
  if (!deliveryHttp) {
    throw new Error(
      `connect-run: auth '${execution.authKey}' has no delivery.http — nothing to inject the captured session into`,
    );
  }

  // AFPS 2.0: resolve the spawnable server from the `source` discriminant.
  // connect.tool requires a LOCAL runner — `remote`/`api` sources have no
  // spawnable server. For a local source the runnable server config lives on
  // the SEPARATE mcp-server package referenced by `source.server.name`.
  const sourceKind = getIntegrationSourceKind(execution.manifest);
  if (sourceKind !== "local") {
    throw new Error(
      `connect-run: integration '${execution.integrationId}' has no spawnable server (connect.tool requires a local node|python|binary|uv runner)`,
    );
  }
  const ref = getLocalServerRef(execution.manifest);
  if (!ref) {
    throw new Error(
      `connect-run: integration '${execution.integrationId}' local source is missing source.server`,
    );
  }
  const mcpServer = await resolveMcpServer(ref.name);
  const run = mcpServer?.server;
  if (!mcpServer || !run?.type || !run.entry_point) {
    throw new Error(
      `connect-run: referenced mcp-server '${ref.name}' could not be resolved (missing or invalid)`,
    );
  }

  const connectMeta = getAppstrateConnectMeta(auth.connect);
  const reauthOn = connectMeta?.reauth_on;
  const authorizedUris = auth.authorized_uris ?? [];

  return {
    integrationId: execution.integrationId,
    // McpHost.normaliseNamespace slugs/caps this — the package id is the same
    // namespace the spawn resolver uses for the agent-run path.
    namespace: execution.integrationId,
    // connect-run only spawns local mcp-server bundles (the connect-login
    // tool can't run against a remote managed MCP — `runConnectOnce`
    // hard-rejects `sourceKind === "remote"`).
    sourceKind: "local",
    manifest: {
      name: execution.manifest.name,
      version: execution.manifest.version,
      server: {
        type: run.type,
        entry_point: run.entry_point,
      },
    },
    spawnEnv: {},
    // Placeholder MITM auth so the sidecar creates the per-integration source +
    // listener. The real session is captured by runConnectLogin at boot.
    httpDeliveryAuths: {
      [execution.authKey]: {
        authType: auth.type,
        headerName: "",
        headerPrefix: "",
        value: "",
        allowServerOverride: false,
        authorizedUris: [...authorizedUris],
        expiresAtEpochMs: null,
      },
    },
    // No agent — expose nothing.
    toolAllowlist: [],
    connectLogin: {
      toolName: execution.toolName,
      ...(execution.produces ? { produces: execution.produces } : {}),
      authKey: execution.authKey,
      authType: auth.type,
      authorizedUris: [...authorizedUris],
      deliveryHttp,
      // The sidecar's MITM substitutes `{{name}}` placeholders only on strings —
      // JSON-stringify non-string credential values so they round-trip cleanly.
      inputs: stringifyInputs(execution.inputs),
      ...(reauthOn ? { reauthOn: [...reauthOn] } : {}),
    },
  };
}

/**
 * Parse the connect-run sidecar's stdout for the result sentinel. Returns the
 * {@link CredentialBundle} on `APPSTRATE_CONNECT_RESULT:`, throws on
 * `APPSTRATE_CONNECT_ERROR:` (carrying the sidecar's message) or when neither
 * sentinel was emitted (sidecar died before producing a result).
 */
export function parseConnectResult(lines: readonly string[]): CredentialBundle {
  // Scan from the end — the sentinel is the last meaningful line the sidecar
  // writes before exiting.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const resultIdx = line.indexOf(RESULT_SENTINEL);
    if (resultIdx !== -1) {
      const json = line.slice(resultIdx + RESULT_SENTINEL.length).trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        throw new Error("connect-run: result sentinel carried invalid JSON");
      }
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("connect-run: result sentinel is not a JSON object");
      }
      const bundle = parsed as CredentialBundle;
      if (typeof bundle.outputs !== "object" || bundle.outputs === null) {
        throw new Error("connect-run: result bundle missing `outputs`");
      }
      return bundle;
    }
    const errIdx = line.indexOf(ERROR_SENTINEL);
    if (errIdx !== -1) {
      const msg = line.slice(errIdx + ERROR_SENTINEL.length).trim();
      throw new Error(`connect-run failed: ${msg || "unknown error"}`);
    }
  }
  throw new Error("connect-run: sidecar exited without emitting a result");
}

class ConnectRunExecutor implements ConnectToolExecutor {
  private readonly orchestrator: ContainerOrchestrator | undefined;
  private readonly timeoutMs: number;
  private readonly resolveMcpServer: McpServerResolver;

  constructor(opts: ConnectRunExecutorOptions = {}) {
    this.orchestrator = opts.orchestrator;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.resolveMcpServer = opts.resolveMcpServer ?? fetchMcpServerManifest;
  }

  async run(execution: ConnectToolExecution): Promise<CredentialBundle> {
    const orch = this.orchestrator ?? getOrchestrator();
    const connectId = `connect_${randomBytes(12).toString("hex")}`;
    const runToken = signRunToken(connectId);

    const spec = await buildConnectLoginSpec(execution, this.resolveMcpServer);

    let boundary: IsolationBoundary | undefined;
    let sidecar: WorkloadHandle | undefined;

    try {
      boundary = await orch.createIsolationBoundary(connectId);
      sidecar = await orch.createSidecar(connectId, boundary, {
        runToken,
        // The sidecar still needs INTEGRATIONS_TO_SPAWN handling off — connect
        // mode short-circuits before the agent boot. We carry the spec via
        // `connectLoginSpec` (→ CONNECT_LOGIN_JSON); `integrations` is set too
        // so `createSidecar` grants the Docker socket the runner spawn needs.
        integrations: [spec],
        connectLoginSpec: spec,
      });

      const bundle = await this.captureBundle(orch, sidecar);
      logger.info("connect-run completed", {
        connectId,
        integrationId: execution.integrationId,
        authKey: execution.authKey,
      });
      return bundle;
    } finally {
      // Cleanup order mirrors runPlatformContainer: sidecar → boundary.
      if (sidecar) {
        await orch.removeWorkload(sidecar).catch((err) => {
          logger.error("connect-run: failed to remove sidecar", {
            connectId,
            error: getErrorMessage(err),
          });
        });
      }
      if (boundary) {
        await orch.removeIsolationBoundary(boundary).catch((err) => {
          logger.error("connect-run: failed to remove isolation boundary", {
            connectId,
            error: getErrorMessage(err),
          });
        });
      }
    }
  }

  /**
   * Start the connect-run sidecar, stream its stdout into a ring buffer, race
   * `waitForExit` against the timeout. On timeout the sidecar is stopped and a
   * throw surfaces. On exit, the sentinel is parsed from the captured lines.
   */
  private async captureBundle(
    orch: ContainerOrchestrator,
    sidecar: WorkloadHandle,
  ): Promise<CredentialBundle> {
    await orch.startWorkload(sidecar);

    const lines: string[] = [];
    const MAX_LINES = 500;
    const logAbort = new AbortController();
    const logStream = (async () => {
      try {
        for await (const line of orch.streamLogs(sidecar, logAbort.signal)) {
          lines.push(line);
          if (lines.length > MAX_LINES) lines.shift();
        }
      } catch {
        // best-effort — the sentinel may still have landed before the abort.
      }
    })();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      orch.stopWorkload(sidecar).catch(() => {});
    }, this.timeoutMs);

    try {
      await orch.waitForExit(sidecar);
      // Drain remaining buffered log lines before parsing.
      logAbort.abort();
      await logStream;

      if (timedOut) {
        throw new Error(`connect-run timed out after ${this.timeoutMs}ms`);
      }
      // Parse regardless of exit code: on a non-zero exit the sidecar emits
      // the ERROR sentinel before exiting 1, which carries the real cause.
      return parseConnectResult(lines);
    } finally {
      clearTimeout(timer);
      logAbort.abort();
    }
  }
}

/**
 * Construct the production {@link ConnectToolExecutor}. Pass to
 * `resolveStrategy(auth, { connectToolExecutor })` so a `runAt: "link"`
 * connect.tool auth resolves to a working {@link OrchestratedStrategy}.
 */
export function createConnectRunExecutor(
  opts: ConnectRunExecutorOptions = {},
): ConnectToolExecutor {
  return new ConnectRunExecutor(opts);
}
