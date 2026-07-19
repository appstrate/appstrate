// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import type { BrowserAcquisitionResult } from "@appstrate/connect/connect";
import { getErrorMessage } from "@appstrate/core/errors";
import type {
  IsolationBoundary,
  RunOrchestrator,
  WorkloadHandle,
} from "@appstrate/core/platform-types";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { getEnv } from "@appstrate/env";

import { getExecutionMode, type ExecutionMode } from "../../infra/mode.ts";
import { logger } from "../../lib/logger.ts";
import { signRunToken } from "../../lib/run-token.ts";
import {
  hasExecutionRequirements,
  resolveBrowserExecutionRequirements,
} from "../browser-execution-profiles.ts";
import { BrowserCapabilityPolicyError } from "../browser-capability-grants.ts";
import {
  getAppstrateConnectMeta,
  getBrowserConnectExecutor,
  getIntegrationSourceKind,
  getLocalServerRef,
  type AfpsManifestAuth,
} from "../integration-manifest-helpers.ts";
import {
  resolveLocalMcpServerExecution,
  type LocalMcpServerManifestResolver,
} from "../resolved-mcp-server-execution.ts";
import { getOrchestrator, orchestratorSupportsSidecarOnly } from "../orchestrator/index.ts";
import { selectOrchestrator } from "../orchestrator/registry.ts";
import type { BrowserConnectExecution, BrowserConnectExecutor } from "./browser-strategy.ts";
import { parseConnectResult } from "./connect-run-launcher.ts";

export interface BrowserConnectRunExecutorOptions {
  readonly orchestrator?: RunOrchestrator;
  readonly timeoutMs?: number;
  readonly resolveMcpServer?: LocalMcpServerManifestResolver;
}

const companionOrchestrators = new Map<string, Promise<RunOrchestrator>>();

async function resolveConnectOrchestrator(): Promise<RunOrchestrator> {
  const current = getExecutionMode();
  const selected = (getEnv().BROWSER_CONNECT_RUN_ADAPTER ??
    (orchestratorSupportsSidecarOnly(current) ? current : "docker")) as ExecutionMode;
  if (!orchestratorSupportsSidecarOnly(selected)) {
    throw new Error(
      `BROWSER_UNAVAILABLE: connect executor '${selected}' cannot run sidecar-only workloads`,
    );
  }
  if (selected === current) return getOrchestrator();

  let pending = companionOrchestrators.get(selected);
  if (!pending) {
    pending = (async () => {
      const orchestrator = selectOrchestrator(selected);
      await orchestrator.initialize();
      await orchestrator.cleanupOrphans();
      return orchestrator;
    })();
    companionOrchestrators.set(selected, pending);
  }
  return pending;
}

export async function buildBrowserConnectSpec(
  execution: BrowserConnectExecution,
  resolveManifest?: LocalMcpServerManifestResolver,
): Promise<IntegrationSpawnSpec> {
  const auths = (execution.manifest.auths ?? {}) as Record<string, AfpsManifestAuth>;
  const auth = auths[execution.authKey];
  if (!auth) throw new Error(`browser-connect: auth '${execution.authKey}' is not declared`);
  const meta = getAppstrateConnectMeta(auth.connect);
  const executor = getBrowserConnectExecutor(auth.connect);
  if (!meta?.tool || !executor || meta.tool !== execution.toolName) {
    throw new Error("browser-connect: execution does not match the manifest executor declaration");
  }
  if (getIntegrationSourceKind(execution.manifest) !== "local") {
    throw new Error("browser-connect: trusted browser drivers must use a local source");
  }
  const ref = getLocalServerRef(execution.manifest);
  if (!ref) throw new Error("browser-connect: local source has no referenced mcp-server");
  const resolution = await resolveLocalMcpServerExecution(
    {
      packageId: ref.name,
      orgId: execution.scope.orgId,
      pin: ref.version,
      sessionMode: execution.sessionMode,
    },
    resolveManifest,
  );
  if (!resolution.ok) {
    throw new Error(
      `browser-connect: referenced mcp-server '${ref.name}@${ref.version}' could not be resolved (${resolution.reason})`,
    );
  }
  const server = resolution.execution;
  if (
    !server.browser ||
    server.browser.purpose !== "connection-acquisition" ||
    !server.browser.trustedDriver ||
    !server.browser.driverGrantId
  ) {
    throw new BrowserCapabilityPolicyError("resolved package is not an authorized browser driver");
  }
  if (executor.session_mode !== execution.sessionMode) {
    throw new Error("browser-connect: requested session mode differs from the manifest");
  }
  if (Object.keys(execution.inputs).length > 128) {
    throw new Error("browser-connect: bootstrap input contains too many fields");
  }
  const stringifyInputs: Record<string, string> = {};
  let encodedBytes = 0;
  for (const [key, value] of Object.entries(execution.inputs)) {
    let encoded: string | undefined;
    try {
      encoded = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      throw new Error(`browser-connect: bootstrap field '${key}' is not serializable`);
    }
    if (encoded === undefined) {
      throw new Error(`browser-connect: bootstrap field '${key}' is not serializable`);
    }
    encodedBytes += Buffer.byteLength(key) + Buffer.byteLength(encoded);
    if (
      key.length === 0 ||
      key.length > 128 ||
      encoded.length > 262_144 ||
      encodedBytes > 262_144
    ) {
      throw new Error("browser-connect: bootstrap input exceeds the private channel limit");
    }
    stringifyInputs[key] = encoded;
  }

  return {
    integrationId: execution.integrationId,
    namespace: execution.integrationId,
    sourceKind: "local",
    manifest: {
      name: execution.manifest.name,
      version: execution.manifest.version,
      server: {
        type: server.runtime,
        entry_point: server.entryPoint,
        packageId: server.packageId,
        ...(server.source === "version" ? { version: server.version } : {}),
      },
    },
    spawnEnv: {},
    toolAllowlist: [],
    hiddenTools: [execution.toolName],
    browser: { ...server.browser, isolationSlot: 0 },
    browserConnect: {
      toolName: execution.toolName,
      produces: [...execution.produces],
      authKey: execution.authKey,
      authType: auth.type,
      authorizedUris: [...(auth.authorized_uris ?? [])],
      sessionMode: execution.sessionMode,
      inputs: stringifyInputs,
      ...(auth.delivery?.http ? { deliveryHttp: auth.delivery.http } : {}),
    },
  };
}

class BrowserConnectRunExecutor implements BrowserConnectExecutor {
  private readonly timeoutMs: number;

  constructor(private readonly options: BrowserConnectRunExecutorOptions) {
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }

  async run(execution: BrowserConnectExecution): Promise<BrowserAcquisitionResult> {
    const orchestrator = this.options.orchestrator ?? (await resolveConnectOrchestrator());
    const connectId = `browser_connect_${randomBytes(12).toString("hex")}`;
    const resultKey = randomBytes(32);
    const runToken = signRunToken(connectId);
    const spec = await buildBrowserConnectSpec(execution, this.options.resolveMcpServer);
    const requirements = resolveBrowserExecutionRequirements([spec]);
    let boundary: IsolationBoundary | undefined;
    let sidecar: WorkloadHandle | undefined;

    try {
      await orchestrator.ensureImages([getEnv().SIDECAR_IMAGE, getEnv().BROWSER_WORKER_IMAGE]);
      boundary = await orchestrator.createIsolationBoundary(connectId, {
        ...(hasExecutionRequirements(requirements) ? { requirements } : {}),
      });
      sidecar = await orchestrator.createSidecar(connectId, boundary, {
        runToken,
        integrations: [spec],
        browserConnectSpec: spec,
        connectResultKey: resultKey.toString("base64"),
      });
      await orchestrator.startWorkload(sidecar);

      const lines: string[] = [];
      const abort = new AbortController();
      const stream = (async () => {
        try {
          for await (const line of orchestrator.streamLogs(sidecar!, abort.signal)) {
            lines.push(line);
            if (lines.length > 500) lines.shift();
          }
        } catch {
          // The exit/result path remains authoritative.
        }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          orchestrator.waitForExit(sidecar),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              void orchestrator.stopWorkload(sidecar!);
              reject(new Error(`browser connect run timed out after ${this.timeoutMs}ms`));
            }, this.timeoutMs);
          }),
        ]);
        abort.abort();
        await stream;
        return parseConnectResult(lines, resultKey) as BrowserAcquisitionResult;
      } finally {
        if (timer) clearTimeout(timer);
        abort.abort();
      }
    } finally {
      if (sidecar) {
        await orchestrator.removeWorkload(sidecar).catch((error) => {
          logger.error("browser connect: sidecar cleanup failed", {
            connectId,
            error: getErrorMessage(error),
          });
        });
      }
      if (boundary) {
        await orchestrator.removeIsolationBoundary(boundary).catch((error) => {
          logger.error("browser connect: boundary cleanup failed", {
            connectId,
            error: getErrorMessage(error),
          });
        });
      }
    }
  }
}

export function createBrowserConnectRunExecutor(
  options: BrowserConnectRunExecutorOptions = {},
): BrowserConnectExecutor {
  return new BrowserConnectRunExecutor(options);
}
