// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import type { BrowserHandle, BrowserProvider, SpawnBrowserOptions } from "./browser-provider.ts";
import { registerBrowserProvider } from "./browser-provider.ts";
import {
  assertBrowserIsolationSlot,
  browserAuthProxyPort,
  browserDevtoolsPort,
  browserWorkerPort,
  isFirecrackerBrowserIsolation,
} from "./browser-guest-isolation.ts";

interface WorkerProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal?: number | string): void;
}

type WorkerSpawn = (
  command: string[],
  options: {
    env: Record<string, string | undefined>;
    stdin: "ignore";
    stdout: "pipe";
    stderr: "ignore";
  },
) => WorkerProcess;

interface ReadyMessage {
  readonly endpoint: string;
  readonly workerBuildId: string;
  readonly protocolVersion: number;
  readonly browserRevision: string;
}

const READY_PREFIX = "APPSTRATE_BROWSER_WORKER_READY:";
const STARTUP_TIMEOUT_MS = 30_000;

async function terminateWorker(proc: WorkerProcess, graceMs = 5_000): Promise<void> {
  proc.kill("SIGTERM");
  const exited = await Promise.race([
    proc.exited.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs)),
  ]);
  if (exited) return;
  proc.kill("SIGKILL");
  await Promise.race([
    proc.exited.catch(() => -1),
    new Promise<number>((resolve) => setTimeout(() => resolve(-1), 500)),
  ]);
}

async function readReadyMessage(stream: ReadableStream<Uint8Array>): Promise<ReadyMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        while (true) {
          const next = await reader.read();
          if (next.done) throw new Error("browser worker exited before reporting ready");
          buffered += decoder.decode(next.value, { stream: true });
          let newline: number;
          while ((newline = buffered.indexOf("\n")) !== -1) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            if (!line.startsWith(READY_PREFIX)) continue;
            const parsed = JSON.parse(line.slice(READY_PREFIX.length)) as ReadyMessage;
            if (
              typeof parsed.endpoint !== "string" ||
              typeof parsed.workerBuildId !== "string" ||
              !/^[A-Za-z0-9._@/+:-]{1,128}$/.test(parsed.workerBuildId) ||
              !Number.isInteger(parsed.protocolVersion) ||
              typeof parsed.browserRevision !== "string" ||
              parsed.browserRevision.length === 0 ||
              parsed.browserRevision.length > 256
            ) {
              throw new Error("browser worker emitted a malformed ready message");
            }
            let endpoint: URL;
            try {
              endpoint = new URL(parsed.endpoint);
            } catch {
              throw new Error("browser worker emitted a malformed ready message");
            }
            if (
              endpoint.protocol !== "http:" ||
              endpoint.origin !== parsed.endpoint ||
              (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "[::1]") ||
              !endpoint.port
            ) {
              throw new Error("browser worker endpoint must be a loopback HTTP origin");
            }
            return parsed;
          }
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`browser worker startup timed out after ${STARTUP_TIMEOUT_MS}ms`)),
          STARTUP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    reader.releaseLock();
  }
}

export function createProcessBrowserProvider(
  deps: {
    spawn?: WorkerSpawn;
    env?: NodeJS.ProcessEnv;
  } = {},
): BrowserProvider {
  const workers = new Map<string, WorkerProcess>();
  const env = deps.env ?? process.env;
  const workerExecutable = env.APPSTRATE_BROWSER_EXEC ?? env.BROWSER_WORKER_EXECUTABLE_PATH;
  const maxConcurrent = Number(env.BROWSER_MAX_CONCURRENT ?? 4);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 128) {
    throw new Error("BROWSER_MAX_CONCURRENT must be an integer from 1 to 128");
  }
  const spawn =
    deps.spawn ??
    ((globalThis as unknown as { Bun?: { spawn?: WorkerSpawn } }).Bun?.spawn as
      WorkerSpawn | undefined);

  return {
    id: "process",
    async prepare(runId) {
      if (!spawn) throw new Error("BROWSER_UNAVAILABLE: Bun.spawn is unavailable");
      if (!workerExecutable) {
        throw new Error(
          "BROWSER_UNAVAILABLE: BROWSER_WORKER_EXECUTABLE_PATH must point to the first-party browser worker",
        );
      }
      return { runId };
    },
    async spawn(options: SpawnBrowserOptions): Promise<BrowserHandle> {
      if (!spawn || !workerExecutable) {
        throw new Error("BROWSER_UNAVAILABLE: process browser worker is not configured");
      }
      if (workers.size >= maxConcurrent) {
        throw new Error(
          `BROWSER_RESOURCE_LIMIT: browser worker capacity reached (${workers.size}/${maxConcurrent})`,
        );
      }
      if (options.spec.providerBinding?.provider === "browser-use-cloud") {
        throw new Error("BROWSER_STATE_CONFLICT: browser binding targets a different provider");
      }
      if (options.spec.providerBinding?.proxy) {
        throw new Error(
          "BROWSER_STATE_CONFLICT: process browser binding cannot carry cloud proxy routing",
        );
      }
      const id = `browser_${randomBytes(12).toString("hex")}`;
      const authToken = randomBytes(32).toString("base64url");
      const guestIsolation = isFirecrackerBrowserIsolation(env);
      const slot = guestIsolation
        ? assertBrowserIsolationSlot(options.spec.isolationSlot)
        : undefined;
      const proc = spawn([workerExecutable, ...(slot === undefined ? [] : [String(slot)])], {
        env: {
          PATH: env.PATH,
          HOME: env.HOME ?? "/tmp",
          TMPDIR: env.TMPDIR ?? "/tmp",
          PORT: String(slot === undefined ? 0 : browserWorkerPort(slot)),
          BROWSER_WORKER_HOST: "127.0.0.1",
          ...(slot === undefined
            ? {}
            : {
                BROWSER_GATEWAY_AUTH_PROXY_PORT: String(browserAuthProxyPort(slot)),
                BROWSER_DEVTOOLS_PORT: String(browserDevtoolsPort(slot)),
              }),
          BROWSER_WORKER_TOKEN: authToken,
          BROWSER_GATEWAY_URL: options.egress.proxyUrl,
          BROWSER_GATEWAY_TOKEN: options.egress.authToken,
          BROWSER_ALLOWED_ORIGINS_JSON: JSON.stringify(options.spec.allowedOrigins),
          APPSTRATE_BROWSER_EXECUTABLE:
            env.APPSTRATE_BROWSER_EXECUTABLE ?? env.BROWSER_EXECUTABLE_PATH,
          BROWSER_MAX_PAGES: String(options.resources.maxPages),
        },
        stdin: "ignore",
        stdout: "pipe",
        // Worker diagnostics are deliberately not forwarded: browser pages,
        // Chromium, and trusted drivers may emit credential-bearing data,
        // and an unread pipe could also deadlock a noisy child.
        stderr: "ignore",
      });
      workers.set(id, proc);
      try {
        const ready = await readReadyMessage(proc.stdout);
        void proc.exited.then(
          () => {
            if (workers.get(id) === proc) workers.delete(id);
          },
          () => {
            if (workers.get(id) === proc) workers.delete(id);
          },
        );
        return {
          id,
          endpoint: ready.endpoint,
          authToken,
          workerBuildId: ready.workerBuildId,
          protocolVersion: ready.protocolVersion,
          browserRevision: ready.browserRevision,
          diagnosticId: id,
        };
      } catch (error) {
        await terminateWorker(proc, 2_000);
        workers.delete(id);
        throw error;
      }
    },
    async stop(handle) {
      const proc = workers.get(handle.id);
      if (!proc) return;
      await terminateWorker(proc);
      workers.delete(handle.id);
    },
    async shutdown() {
      for (const [id, proc] of [...workers]) {
        await terminateWorker(proc);
        workers.delete(id);
      }
    },
  };
}

registerBrowserProvider({ id: "process", create: () => createProcessBrowserProvider() });
