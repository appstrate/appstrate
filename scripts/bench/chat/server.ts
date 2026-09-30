// SPDX-License-Identifier: Apache-2.0

/**
 * Boots one isolated platform process for the chat benchmark: its own port, its
 * own database (the bench compose stack, or a throwaway PGlite directory), its
 * own storage, and an env built from scratch — a developer's `.env`, dev server
 * and data are never read or touched. The process's structured logs are
 * captured: the platform already logs the per-turn phase timings the bench
 * joins (`chat preamble`, `chat turn construction`, `llm-proxy call`).
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lines } from "./lines.ts";

export const INFRAS = ["prod-like", "pglite"] as const;
export type Infra = (typeof INFRAS)[number];

export interface ServerOptions {
  /** Checkout whose `apps/api/src/index.ts` is booted (a worktree for another ref). */
  checkout: string;
  port: number;
  infra: Infra;
  /** This boot's env file and log. */
  workDir: string;
  /** PGlite data and filesystem storage, shared by every boot of a bench run. */
  dataDir: string;
  systemProviderKeys: unknown[];
  /** Overrides applied last (relay endpoints, upstream allowances, `--env`). */
  env: Record<string, string>;
  /** Receives the process's `stop` as soon as it is spawned, so an interrupted boot is still torn down. */
  onSpawn(stop: () => Promise<void>): void;
}

export interface LogLine {
  /** Arrival time on the bench clock. */
  at: number;
  msg: string;
  fields: Record<string, unknown>;
}

export interface BenchServer {
  origin: string;
  logs: LogLine[];
  bootMs: number;
  stop(): Promise<void>;
}

/** The bench compose stack's endpoints (`docker-compose.bench.yml`). */
export const PROD_LIKE_ENV = {
  DATABASE_URL: "postgresql://bench:bench@127.0.0.1:55432/bench",
  REDIS_URL: "redis://127.0.0.1:56379",
  S3_BUCKET: "bench",
  S3_REGION: "us-east-1",
  S3_ENDPOINT: "http://127.0.0.1:59000",
  AWS_ACCESS_KEY_ID: "benchadmin",
  AWS_SECRET_ACCESS_KEY: "benchadmin-secret",
};

const BOOT_TIMEOUT_MS = 120_000;
const now = () => performance.timeOrigin + performance.now();

/** Uncommented `KEY=value` lines of a dotenv file, quotes stripped; `{}` when there is no file. */
export async function readDotenv(path: string): Promise<Record<string, string>> {
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of (await Bun.file(path).text()).split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const value = match[2]!;
    env[match[1]!] = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return env;
}

export async function startServer(opts: ServerOptions): Promise<BenchServer> {
  mkdirSync(opts.workDir, { recursive: true });
  const origin = `http://localhost:${opts.port}`;
  const env: Record<string, string> = {
    // The checkout's `.env.example`: the dev baseline that boots, for that ref.
    ...(await readDotenv(join(opts.checkout, ".env.example"))),
    PORT: String(opts.port),
    APP_URL: origin,
    TRUSTED_ORIGINS: origin,
    LOG_LEVEL: "info",
    SYSTEM_PROVIDER_KEYS: JSON.stringify(opts.systemProviderKeys),
    ...(opts.infra === "prod-like"
      ? PROD_LIKE_ENV
      : {
          PGLITE_DATA_DIR: join(opts.dataDir, "pglite"),
          FS_STORAGE_PATH: join(opts.dataDir, "storage"),
        }),
    ...opts.env,
  };

  // The env file holds provider keys: it leaves the disk once `/health` answers
  // or the boot fails, and on exit if the bench is interrupted.
  const envFile = join(opts.workDir, "bench.env");
  const dropEnvFile = () => rmSync(envFile, { force: true });
  process.once("exit", dropEnvFile);
  const logs: LogLine[] = [];
  const logPath = join(opts.workDir, "server.log");
  const logFile = Bun.file(logPath).writer();
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let pumps: Promise<unknown> = Promise.resolve();

  const shutdown = async () => {
    const child = proc;
    if (child) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await child.exited;
      clearTimeout(timer);
    }
    // The pipes can still hold the last lines after the exit.
    await pumps;
    await logFile.end();
  };
  let stopped: Promise<void> | null = null;
  const stop = () => (stopped ??= shutdown());

  const startedAt = now();
  try {
    assertPortFree(opts.port);
    writeFileSync(
      envFile,
      Object.entries(env)
        .map(([key, value]) => {
          // Single quotes: dotenv takes their content verbatim (JSON stays intact).
          if (value.includes("'")) throw new Error(`bench env ${key} cannot hold a single quote`);
          return `${key}='${value}'`;
        })
        .join("\n"),
      { mode: 0o600 },
    );
    // `--env-file` replaces Bun's implicit `.env` loading, so nothing from the
    // checkout's own `.env` reaches the process; the parent env is not passed either.
    const child = Bun.spawn(["bun", `--env-file=${envFile}`, "apps/api/src/index.ts"], {
      cwd: opts.checkout,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    proc = child;
    opts.onSpawn(stop);
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      for await (const line of lines(stream, (text) => void logFile.write(text))) {
        if (!line.startsWith("{")) continue;
        try {
          const fields = JSON.parse(line) as Record<string, unknown>;
          logs.push({ at: now(), msg: String(fields.msg ?? ""), fields });
        } catch {
          // Not a log record (a stack trace): server.log keeps it.
        }
      }
    };
    pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (!(await isHealthy(origin))) {
      if (child.exitCode !== null) {
        throw new Error(`bench API exited during boot (code ${child.exitCode}); see ${logPath}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`bench API not healthy after ${BOOT_TIMEOUT_MS / 1000} s; see ${logPath}`);
      }
      await Bun.sleep(100);
    }
    return { origin, logs, bootMs: now() - startedAt, stop };
  } catch (err) {
    await stop();
    throw err;
  } finally {
    dropEnvFile();
    process.off("exit", dropEnvFile);
  }
}

/** Anything already listening would answer `/health` in place of this boot's process. */
function assertPortFree(port: number) {
  try {
    Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } }).stop(true);
  } catch {
    throw new Error(`port ${port} is taken (a bench API left running?): free it or pass --port`);
  }
}

const isHealthy = (origin: string) =>
  fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) }).then(
    (res) => res.ok,
    () => false,
  );
