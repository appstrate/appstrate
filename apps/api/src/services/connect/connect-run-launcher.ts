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

import { getAppstrateConnectMeta } from "@appstrate/core/integration";
import { createDecipheriv, randomBytes } from "node:crypto";

import { toCredentialStringMap } from "@appstrate/connect/integration-credentials";
import { ApiError } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { signRunToken } from "../../lib/run-token.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  CONNECT_LOGIN_TOOL_ERROR_PREFIX,
  type IntegrationSpawnSpec,
} from "@appstrate/core/sidecar-types";
import {
  getIntegrationSourceKind,
  getLocalServer,
  getLocalServerEnv,
} from "@appstrate/core/integration";
import { effectiveMcpServerType } from "@appstrate/core/mcp-server";
import { runnerEgressFor, type AfpsManifestAuth } from "../integration-manifest-helpers.ts";
import {
  getOrchestrator,
  orchestratorSupportsSidecarOnly,
  type RunOrchestrator,
  type IsolationBoundary,
  type WorkloadHandle,
} from "../orchestrator/index.ts";
import { assertRunCapacityReady } from "../orchestrator/agent-runtime-readiness.ts";
import { getExecutionMode } from "../../infra/mode.ts";
import {
  CONNECT_ID_PREFIX,
  connectRunGrantTtlSeconds,
  deleteConnectRunGrant,
  writeConnectRunGrant,
} from "./connect-run-grant.ts";
import type { ConnectToolExecution, ConnectToolExecutor } from "./orchestrated-strategy.ts";
import { loginRejected, loginTimedOut, type CredentialBundle } from "./strategy.ts";

const RESULT_SENTINEL = "APPSTRATE_CONNECT_RESULT:";
const ERROR_SENTINEL = "APPSTRATE_CONNECT_ERROR:";

/** Log lines kept for the operator when the sidecar dies without a sentinel. */
const CRASH_TAIL_LINES = 30;

/** Cap on the integration-authored diagnostic we echo back to the caller. */
const MAX_DIAGNOSTIC_CHARS = 300;

/**
 * Extract the caller-safe login diagnostic from a raw `APPSTRATE_CONNECT_ERROR:`
 * message, or `null` when the message is a sidecar-internal fault (which the
 * caller must never see). Returns the tool's own text as a sentence, or `""`
 * when it carried none.
 *
 * The discriminator is `CONNECT_LOGIN_TOOL_ERROR_PREFIX`, which the sidecar's
 * connect-login primitive puts on a failure the LOGIN TOOL ITSELF reported — the
 * ONE error class on this channel written for the person logging in ("wrong
 * password", "MFA required", "captcha").
 *
 * `APPSTRATE_CONNECT_ERROR:` itself is a catch-all — `runtime-pi/sidecar/server.ts`
 * puts `err.message` of ANY throw in connect mode on it, including runner-spawn
 * failures, CA/MITM faults and bundle-framing errors whose text can carry host
 * paths, namespaces and env-var names. Those must NOT reach the caller of the
 * hosted end-user form, so only the marked subset is surfaced here; everything
 * else stays an opaque 500 with the raw text in the platform logs.
 */
function loginToolDiagnostic(msg: string): string | null {
  if (!msg.startsWith(CONNECT_LOGIN_TOOL_ERROR_PREFIX)) return null;
  const detail = msg.slice(CONNECT_LOGIN_TOOL_ERROR_PREFIX.length).replace(/^:\s*/, "").trim();
  if (!detail) return "";
  // The text is authored by the integration package — clip it so a runaway
  // upstream body can't be pasted wholesale into an API response.
  const clipped =
    detail.length > MAX_DIAGNOSTIC_CHARS ? `${detail.slice(0, MAX_DIAGNOSTIC_CHARS)}…` : detail;
  return /[.!?…]$/.test(clipped) ? clipped : `${clipped}.`;
}

/** How long to wait for the connect-run sidecar to mint the session before killing it. */
const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

interface ConnectRunExecutorOptions {
  /** Injectable orchestrator — production defaults to the global singleton. */
  orchestrator?: RunOrchestrator;
  /** Override the connect-run timeout (ms). Defaults to 60s. */
  timeoutMs?: number;
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
export async function buildConnectLoginSpec(
  execution: ConnectToolExecution,
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

  // connect.tool requires a LOCAL runner — `remote`/`api` sources have no spawnable server. A
  // local source declares its server inline and ships its payload in the integration's own
  // archive.
  const sourceKind = getIntegrationSourceKind(execution.manifest);
  if (sourceKind !== "local") {
    throw new Error(
      `connect-run: integration '${execution.integrationId}' has no spawnable server (connect.tool requires a local node|python|binary|uv runner)`,
    );
  }
  // The runtime this server actually spawns under — the SAME core reader the agent-run spawn
  // resolver uses, so both paths spawn a given integration under one interpreter.
  const localServer = getLocalServer(execution.manifest);
  const type = localServer ? effectiveMcpServerType(execution.manifest) : undefined;
  if (!localServer || !type) {
    throw new Error(
      `connect-run: integration '${execution.integrationId}' local source has no runnable source.server`,
    );
  }
  const version = execution.bundleVersion;

  const connectMeta = getAppstrateConnectMeta(auth.connect);
  const reauthOn = connectMeta?.reauth_on;
  const authorizedUris = auth.authorized_uris ?? [];
  const egress = runnerEgressFor(auth, authorizedUris);

  return {
    integrationId: execution.integrationId,
    // Use the package ID as the namespace input, as the agent-run spawn resolver does.
    namespace: execution.integrationId,
    // connect-run only spawns local servers (the connect-login
    // tool can't run against a remote managed MCP — `runConnectOnce`
    // hard-rejects `sourceKind === "remote"`).
    sourceKind: "local",
    manifest: {
      name: execution.manifest.name,
      version: execution.manifest.version,
      // The runnable bytes live in the integration's own archive, fetched by `integrationId`.
      server: {
        type,
        entry_point: localServer.entry_point,
        // The published version the manifest was read from, served by the byte route as
        // `?version=`. Absent for a system integration and for an unpublished draft.
        ...(version ? { version } : {}),
      },
    },
    // The server's literal `mcp_config.env`, as on the agent-run path.
    spawnEnv: getLocalServerEnv(execution.manifest),
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
      variables: {},
      // Same projection as the run-start re-bootstrap reads back from storage
      // (`decryptCredentialInputsToStringMap`), so a login input is never
      // delivered on the first login and lost on the next.
      inputs: toCredentialStringMap(execution.inputs),
      ...(reauthOn ? { reauthOn: [...reauthOn] } : {}),
    },
    // The login runner's MITM enforces the same allowlist as an agent run's.
    ...(egress ? { egress } : {}),
  };
}

/**
 * Decrypt a connect-run result payload. The wire format written by the sidecar
 * (`runtime-pi/sidecar/server.ts`) is base64(iv‖authTag‖ciphertext) under
 * AES-256-GCM keyed by the per-connect-run ephemeral `resultKey`. Any failure
 * (malformed base64, truncated payload, auth-tag mismatch, wrong key) throws —
 * the caller maps it onto a structured "could not decrypt" strategy error.
 */
function decryptConnectResult(payloadB64: string, resultKey: Buffer): string {
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

/**
 * Parse the connect-run sidecar's stdout for the result sentinel. Returns the
 * {@link CredentialBundle} on `APPSTRATE_CONNECT_RESULT:` (decrypting its
 * ciphertext payload with `resultKey`), throws on `APPSTRATE_CONNECT_ERROR:`,
 * and returns `null` when neither sentinel was emitted (sidecar died before
 * producing a result) — the caller owns that diagnosis.
 *
 * The throw is typed by audience, not by convenience:
 *   - a login-tool rejection (see {@link loginToolDiagnostic}) throws an
 *     `ApiError` 400 carrying the tool's diagnostic — the routes' existing
 *     `if (err instanceof ApiError) throw err` passthrough hands it to the
 *     caller verbatim;
 *   - every other failure (bad bundle framing, decrypt failure, malformed
 *     payload, sidecar-internal fault) throws a PLAIN Error, which the routes
 *     log and collapse into the generic 500 — sidecar internals must never
 *     reach an end user on the hosted connect form.
 */
export function parseConnectResult(
  lines: readonly string[],
  resultKey: Buffer,
): CredentialBundle | null {
  // Scan from the end — the sentinel is the last meaningful line the sidecar
  // writes before exiting.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const resultIdx = line.indexOf(RESULT_SENTINEL);
    if (resultIdx !== -1) {
      const payload = line.slice(resultIdx + RESULT_SENTINEL.length).trim();
      let json: string;
      try {
        json = decryptConnectResult(payload, resultKey);
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
      const diagnostic = loginToolDiagnostic(msg);
      if (diagnostic !== null) {
        // The login tool rejected the caller's OWN credentials — a 4xx about
        // their input, not a server fault. Surface the tool's diagnostic so the
        // connect form can say "wrong password" / "MFA required" instead of
        // "An internal error occurred", and name the remedy.
        // The tool's own text, if any, rides `integration_diagnostic` for a client to show as is.
        throw diagnostic
          ? loginRejected(diagnostic, { kind: "integration", diagnostic })
          : loginRejected("The integration rejected the submitted credentials.");
      }
      // Anything else on this channel is a sidecar-internal fault: stay a plain
      // Error so the routes map it to a generic 500 (the raw text is logged
      // there) rather than exposing sidecar internals to a hosted-form caller.
      throw new Error(`connect-run failed: ${msg || "unknown error"}`);
    }
  }
  return null;
}

class ConnectRunExecutor implements ConnectToolExecutor {
  private readonly orchestrator: RunOrchestrator | undefined;
  private readonly timeoutMs: number;

  constructor(opts: ConnectRunExecutorOptions = {}) {
    this.orchestrator = opts.orchestrator;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  async run(execution: ConnectToolExecution): Promise<CredentialBundle> {
    // Capability gate on the GLOBAL backend only — an injected orchestrator
    // (tests) is the caller's contract to honour.
    if (!this.orchestrator && !orchestratorSupportsSidecarOnly(getExecutionMode())) {
      const mode = getExecutionMode();
      // The caller (possibly an end user on the hosted form) gets the generic
      // 503 detail; the operator-facing remedy lands here, in the logs.
      logger.error("connect-run unsupported by the configured execution backend", {
        mode,
        remedy: `RUN_ADAPTER="${mode}" cannot run a sidecar-only workload — use RUN_ADAPTER=docker (or process) for connect flows.`,
      });
      // The configured execution backend cannot host a connect-run (sidecar-only
      // workload). Thrown BEFORE any boundary is created so the caller gets a
      // clear diagnosis instead of a sidecar that silently never reports.
      //
      // It IS an `ApiError` so it rides the connect routes' existing
      // `if (err instanceof ApiError) throw err` passthrough and reaches the
      // caller as a 503 — "unavailable, don't retry with other credentials" —
      // instead of collapsing into the opaque `internal_error` 500 every other
      // connect-run failure produced.
      //
      // The public `detail` is deliberately generic.
      // `POST /api/integrations/connect/submit` is the HOSTED end-user form,
      // reachable by someone who is not a member of the organization, and the
      // actual remedy here (`RUN_ADAPTER=docker`) is operator-facing deployment
      // configuration: naming it to that audience leaks deployment shape and
      // gives them nothing they can act on. The remedy is logged just above,
      // where the operator reads it.
      throw new ApiError({
        status: 503,
        code: "connect_unavailable",
        title: "Service Unavailable",
        detail:
          "This connection method is unavailable on this deployment. Contact your administrator.",
      });
    }
    // A connect login spawns a sidecar container: refused until the boot's
    // run-capacity phase is done (see `assertRunCapacityReady`).
    assertRunCapacityReady();
    const orch = this.orchestrator ?? getOrchestrator();
    // Prefix comes from the grant module so the mint site and the
    // `/internal/*` discriminator can never drift apart.
    const connectId = `${CONNECT_ID_PREFIX}${randomBytes(12).toString("hex")}`;
    const runToken = signRunToken(connectId);
    // Per-connect-run ephemeral key for the result channel. The sidecar
    // encrypts the captured credential bundle with it (AES-256-GCM) before
    // writing the APPSTRATE_CONNECT_RESULT sentinel, so the plaintext credential
    // never lands on the orchestrator-captured stdout stream. Held only in this
    // stack frame; never logged, serialized, or persisted.
    const resultKey = randomBytes(32);

    const spec = await buildConnectLoginSpec(execution);

    let boundary: IsolationBoundary | undefined;
    let sidecar: WorkloadHandle | undefined;

    try {
      // The connect run's ENTIRE authorization on `/internal/*`. There is no
      // `runs` row behind `connectId` and no agent manifest to walk, so the
      // grant is what the byte + credentials routes match against — one
      // integration, one concrete version, for as long as this
      // connect run lives. Written BEFORE the sidecar exists so its first call
      // already finds it, and revoked in the `finally` below.
      await writeConnectRunGrant(
        connectId,
        {
          orgId: execution.scope.orgId,
          integrationId: execution.integrationId,
          // `null` = a system integration or an unpublished draft (no version for the byte route
          // to look up). The grant then authorises ONLY that unversioned answer.
          version: spec.manifest.server?.version ?? null,
        },
        connectRunGrantTtlSeconds(this.timeoutMs),
      );

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

      const bundle = await this.captureBundle(orch, sidecar, resultKey, connectId);
      logger.info("connect-run completed", {
        connectId,
        integrationId: execution.integrationId,
        authKey: execution.authKey,
      });
      return bundle;
    } finally {
      // Revoke the grant FIRST: past this line no token bearing `connectId`
      // authorises anything, whether the run succeeded, failed, or timed out.
      // The TTL is only the crash backstop for a process that never reaches
      // here.
      await deleteConnectRunGrant(connectId).catch((err) => {
        logger.error("connect-run: failed to revoke the authorization grant", {
          connectId,
          error: getErrorMessage(err),
        });
      });
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
    connectId: string,
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
      const exitCode = await orch.waitForExit(sidecar);
      // Drain remaining buffered log lines before parsing.
      logAbort.abort();
      await logStream;

      if (timedOut) {
        // Not a server bug: the login dance did not finish inside the budget
        // (slow provider, an interactive step the tool cannot complete). A
        // gateway-timeout tells the caller retrying is the right move, where the
        // generic 500 told them nothing.
        logger.warn("connect-run timed out", { timeoutMs: this.timeoutMs });
        throw loginTimedOut(this.timeoutMs);
      }
      // Parse regardless of exit code: on a non-zero exit the sidecar emits
      // the ERROR sentinel before exiting 1, which carries the real cause.
      const bundle = parseConnectResult(lines, resultKey);
      // null = no sentinel: the sidecar died before reporting (OOM, boot
      // failure). Only then is the tail logged — no line carries ciphertext.
      if (bundle === null) {
        logger.error("connect-run: sidecar exited without emitting a result", {
          connectId,
          exitCode,
          tail: lines.slice(-CRASH_TAIL_LINES).join("\n"),
        });
        // Operator-facing only: the routes log it and answer a generic 500.
        throw new Error(
          `connect-run: sidecar exited with code ${exitCode} without emitting a result`,
        );
      }
      return bundle;
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
