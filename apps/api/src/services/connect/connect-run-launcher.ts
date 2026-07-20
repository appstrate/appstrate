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
 *      container) in connect mode via {@link RunOrchestrator.createSidecar}
 *      with `connectLoginSpec` set,
 *   4. captures the sidecar's stdout, decrypts the `APPSTRATE_CONNECT_RESULT:`
 *      sentinel (or reads the plaintext `APPSTRATE_CONNECT_ERROR:` sentinel)
 *      into a {@link CredentialBundle} (or a thrown error),
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
 * The captured bundle returns on the sidecar's sentinel stdout line, which the
 * orchestrator captures (Docker logging driver → log collection in prod). To
 * keep the plaintext credential off that surface, the sidecar encrypts the
 * bundle with a per-connect-run ephemeral AES-256-GCM key this launcher
 * generates and hands it via `CONNECT_RESULT_KEY` (same env trust channel as
 * `CONNECT_LOGIN_JSON`). The launcher retains the key in-memory and decrypts
 * the sentinel below — plaintext bundle bytes never touch stdout/stderr/logs.
 */

import { createDecipheriv, randomBytes } from "node:crypto";

import { logger } from "../../lib/logger.ts";
import { signConnectWorkloadToken } from "../../lib/connect-workload-token.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import {
  resolveLocalMcpServerExecution,
  type LocalMcpServerExecutionResolution,
} from "../resolved-mcp-server-execution.ts";
import {
  getIntegrationSourceKind,
  getLocalServerRef,
  getAppstrateConnectMeta,
  type AfpsManifestAuth,
} from "../integration-manifest-helpers.ts";
import {
  getOrchestrator,
  orchestratorSupportsSidecarOnly,
  type RunOrchestrator,
  type IsolationBoundary,
  type WorkloadHandle,
} from "../orchestrator/index.ts";
import { getExecutionMode } from "../../infra/mode.ts";
import type { ConnectToolExecution, ConnectToolExecutor } from "./orchestrated-strategy.ts";
import type { CredentialBundle } from "./strategy.ts";

const RESULT_SENTINEL = "APPSTRATE_CONNECT_RESULT:";
const ERROR_SENTINEL = "APPSTRATE_CONNECT_ERROR:";
const BROWSER_INTERACTION_SENTINEL = "APPSTRATE_BROWSER_INTERACTION:";

/**
 * Coerce a credential bag's values to strings. The sidecar's MITM substitutes
 * `{{name}}` placeholders only on strings (a URL or header value template
 * has no notion of "substitute a number"), so non-string credential values
 * are JSON-stringified at this boundary. The route layer's
 * `importConnectionSchema` accepts JSON-typed credentials per JSON Schema
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

/**
 * The configured execution backend cannot host a connect-run (sidecar-only
 * workload). Thrown BEFORE any boundary is created so the caller gets a
 * clear diagnosis instead of "sidecar exited without emitting a result".
 */
export class ConnectNotSupportedError extends Error {
  constructor(mode: string) {
    super(
      `connect-runs are not supported with RUN_ADAPTER="${mode}" — this backend cannot ` +
        `run a sidecar-only workload. Use RUN_ADAPTER=docker (or process) for connect flows.`,
    );
    this.name = "ConnectNotSupportedError";
  }
}

export interface ConnectRunExecutorOptions {
  /** Injectable orchestrator — production defaults to the global singleton. */
  orchestrator?: RunOrchestrator;
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
  orgId: string,
  pin?: string | null,
) => Promise<LocalMcpServerExecutionResolution>;

export async function buildConnectLoginSpec(
  execution: ConnectToolExecution,
  resolveMcpServer: McpServerResolver = (packageId, orgId, pin) =>
    resolveLocalMcpServerExecution({ packageId, orgId, pin }),
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

  // AFPS: resolve the spawnable server from the `source` discriminant.
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
  const resolution = await resolveMcpServer(ref.name, execution.scope.orgId, ref.version);
  if (!resolution.ok) {
    throw new Error(
      `connect-run: referenced mcp-server '${ref.name}@${ref.version}' could not be resolved (${resolution.reason})`,
    );
  }
  const resolvedServer = resolution.execution;
  if (resolvedServer.browser) {
    throw new Error(
      "connect-run: a browser-capable mcp-server requires the explicit trusted browser executor marker",
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
        type: resolvedServer.runtime,
        entry_point: resolvedServer.entryPoint,
        packageId: resolvedServer.packageId,
        ...(resolvedServer.source === "version" ? { version: resolvedServer.version } : {}),
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
    ...(resolvedServer.workspaceMount ? { workspaceMount: resolvedServer.workspaceMount } : {}),
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
 * Decrypt a connect-run result payload. The wire format written by the sidecar
 * (`runtime-pi/sidecar/server.ts`) is base64(iv‖authTag‖ciphertext) under
 * AES-256-GCM keyed by the per-connect-run ephemeral `resultKey`. Any failure
 * (malformed base64, truncated payload, auth-tag mismatch, wrong key) throws —
 * the caller maps it onto a structured "could not decrypt" strategy error.
 */
function decryptConnectPayload(payloadB64: string, resultKey: Buffer): string {
  const buf = Buffer.from(payloadB64, "base64");
  // 12-byte GCM iv + 16-byte auth tag = 28-byte minimum framing.
  if (buf.length < 28) {
    throw new Error("connect-run: result payload too short to contain iv + auth tag");
  }
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", resultKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function isBrowserUseHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "browser-use.com" || host.endsWith(".browser-use.com");
}

/**
 * Parse one encrypted human-interaction event emitted by a browser connect
 * sidecar. Returns null for ordinary log lines. The live URL is deliberately
 * validated again at the API trust boundary before it can reach the UI.
 */
export function parseBrowserInteraction(line: string, resultKey: Buffer): string | null {
  const idx = line.indexOf(BROWSER_INTERACTION_SENTINEL);
  if (idx === -1) return null;
  const payload = line.slice(idx + BROWSER_INTERACTION_SENTINEL.length).trim();
  let json: string;
  try {
    json = decryptConnectPayload(payload, resultKey);
  } catch {
    throw new Error("connect-run: browser interaction sentinel could not be decrypted");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("connect-run: browser interaction sentinel carried invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("connect-run: browser interaction sentinel is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    typeof record.url !== "string" ||
    record.url.length === 0 ||
    record.url.length > 4096
  ) {
    throw new Error("connect-run: browser interaction sentinel is malformed");
  }
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    throw new Error("connect-run: browser interaction URL is malformed");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !isBrowserUseHost(url.hostname)
  ) {
    throw new Error("connect-run: browser interaction URL is unsafe");
  }
  return url.toString();
}

/**
 * Parse the connect-run sidecar's stdout for the result sentinel. Returns the
 * {@link CredentialBundle} on `APPSTRATE_CONNECT_RESULT:` (decrypting its
 * ciphertext payload with `resultKey`), throws on `APPSTRATE_CONNECT_ERROR:`
 * (carrying the sidecar's plaintext message) or when neither sentinel was
 * emitted (sidecar died before producing a result).
 */
export function parseConnectResult(lines: readonly string[], resultKey: Buffer): CredentialBundle {
  // Scan from the end — the sentinel is the last meaningful line the sidecar
  // writes before exiting.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const resultIdx = line.indexOf(RESULT_SENTINEL);
    if (resultIdx !== -1) {
      const payload = line.slice(resultIdx + RESULT_SENTINEL.length).trim();
      let json: string;
      try {
        json = decryptConnectPayload(payload, resultKey);
      } catch {
        // Never surface the raw payload / crypto detail — a decrypt failure is
        // opaque by design (wrong key, tampered log line, truncated capture).
        throw new Error("connect-run: result sentinel could not be decrypted");
      }
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
  private readonly orchestrator: RunOrchestrator | undefined;
  private readonly timeoutMs: number;
  private readonly resolveMcpServer: McpServerResolver;

  constructor(opts: ConnectRunExecutorOptions = {}) {
    this.orchestrator = opts.orchestrator;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.resolveMcpServer =
      opts.resolveMcpServer ??
      ((packageId, orgId, pin) => resolveLocalMcpServerExecution({ packageId, orgId, pin }));
  }

  async run(execution: ConnectToolExecution): Promise<CredentialBundle> {
    // Capability gate on the GLOBAL backend only — an injected orchestrator
    // (tests) is the caller's contract to honour.
    if (!this.orchestrator && !orchestratorSupportsSidecarOnly(getExecutionMode())) {
      throw new ConnectNotSupportedError(getExecutionMode());
    }
    const orch = this.orchestrator ?? getOrchestrator();
    const connectId = `connect_${randomBytes(12).toString("hex")}`;
    // Per-connect-run ephemeral key for the result channel. The sidecar
    // encrypts the captured credential bundle with it (AES-256-GCM) before
    // writing the APPSTRATE_CONNECT_RESULT sentinel, so the plaintext credential
    // never lands on the orchestrator-captured stdout stream. Held only in this
    // stack frame; never logged, serialized, or persisted.
    const resultKey = randomBytes(32);

    const spec = await buildConnectLoginSpec(execution, this.resolveMcpServer);
    const server = spec.manifest.server;
    if (!server?.packageId) {
      throw new Error("connect-run: resolved mcp-server package id is missing");
    }
    const runToken = signConnectWorkloadToken({
      connectId,
      orgId: execution.scope.orgId,
      applicationId: execution.scope.applicationId,
      integrationId: execution.integrationId,
      mcpServerId: server.packageId,
      mcpServerVersion: server.version ?? null,
      mcpServerSource: server.version ? "version" : "system",
      ttlMs: Math.min(this.timeoutMs + 30_000, 5 * 60_000),
    });
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
        // → CONNECT_RESULT_KEY: the sidecar encrypts its result sentinel with this.
        connectResultKey: resultKey.toString("base64"),
      });

      const bundle = await this.captureBundle(orch, sidecar, resultKey);
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
    orch: RunOrchestrator,
    sidecar: WorkloadHandle,
    resultKey: Buffer,
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
      return parseConnectResult(lines, resultKey);
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
