// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import type { BrowserHandle, BrowserProvider, SpawnBrowserOptions } from "./browser-provider.ts";
import { registerBrowserProvider } from "./browser-provider.ts";

export type BrowserDockerExec = (args: string[]) => Promise<string>;
export type BrowserProviderFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

async function defaultDockerExec(args: string[]): Promise<string> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`docker ${args[0]} failed: ${stderr.trim() || stdout.trim()}`);
  return stdout.trim();
}

async function writeWorkerEnv(
  values: Record<string, string>,
): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "appstrate-browser-env-"));
  const path = join(dir, "worker.env");
  await writeFile(
    path,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  return { dir, path };
}

function isContainerNameConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:container name.*already in use|conflict.*container name)/i.test(error.message)
  );
}

export function createDockerBrowserProvider(
  deps: {
    exec?: BrowserDockerExec;
    fetchFn?: BrowserProviderFetch;
    env?: NodeJS.ProcessEnv;
    existsFn?: (path: string) => boolean;
  } = {},
): BrowserProvider {
  const exec = deps.exec ?? defaultDockerExec;
  const fetchFn = deps.fetchFn ?? fetch;
  const env = deps.env ?? process.env;
  const existsFn = deps.existsFn ?? existsSync;
  const maxConcurrent = Number(env.BROWSER_MAX_CONCURRENT ?? 4);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 128) {
    throw new Error("BROWSER_MAX_CONCURRENT must be an integer from 1 to 128");
  }
  const containers = new Map<string, string>();
  let runNetwork: string | null = null;
  const seccompProfile = [
    env.APPSTRATE_BROWSER_SECCOMP_PROFILE,
    "/usr/local/share/appstrate/browser-seccomp.json",
    join(process.cwd(), "runtime-pi/sidecar/browser-seccomp.json"),
  ].find((candidate): candidate is string => !!candidate && existsFn(candidate));

  return {
    id: "docker",
    async prepare(runId) {
      if (!seccompProfile) {
        throw new Error(
          "BROWSER_UNAVAILABLE: the pinned Chromium seccomp profile is not installed",
        );
      }
      runNetwork = env.RUN_ID ? `appstrate-exec-${env.RUN_ID}` : `appstrate-exec-${runId}`;
      return { runId };
    },
    async spawn(options: SpawnBrowserOptions): Promise<BrowserHandle> {
      if (!runNetwork) throw new Error("BROWSER_UNAVAILABLE: docker provider was not prepared");
      if (containers.size >= maxConcurrent) {
        throw new Error(
          `BROWSER_RESOURCE_LIMIT: browser worker capacity reached (${containers.size}/${maxConcurrent})`,
        );
      }
      const image = env.BROWSER_WORKER_IMAGE || "appstrate-browser-worker:latest";
      const id = `browser_${randomBytes(12).toString("hex")}`;
      const authToken = randomBytes(32).toString("base64url");
      const workerEnv = await writeWorkerEnv({
        PORT: "8080",
        BROWSER_WORKER_TOKEN: authToken,
        BROWSER_GATEWAY_URL: options.egress.proxyUrl,
        BROWSER_GATEWAY_TOKEN: options.egress.authToken,
        BROWSER_ALLOWED_ORIGINS_JSON: JSON.stringify(options.spec.allowedOrigins),
        BROWSER_MAX_PAGES: String(options.resources.maxPages),
      });
      let containerId: string | undefined;
      let name: string | undefined;
      try {
        // The daemon arbitrates these fixed names atomically across every
        // sidecar on the host. A per-process Map alone would make the limit
        // per-run and allow N concurrent runs to each consume the full host
        // ceiling.
        for (let slot = 0; slot < maxConcurrent; slot += 1) {
          const candidate = `appstrate-browser-slot-${slot}`;
          try {
            const created = await exec([
              "create",
              "--name",
              candidate,
              "--network",
              runNetwork,
              "--security-opt",
              "no-new-privileges",
              // This is Moby's pinned default allowlist plus the namespace/chroot
              // syscalls Chromium needs for its own sandbox. It is deliberately
              // narrower than seccomp=unconfined and keeps --no-sandbox forbidden.
              "--security-opt",
              `seccomp=${seccompProfile}`,
              "--cap-drop",
              "ALL",
              "--read-only",
              "--tmpfs",
              `/tmp:rw,noexec,nosuid,size=${options.resources.shmBytes}`,
              "--shm-size",
              String(options.resources.shmBytes),
              "--memory",
              String(options.resources.memoryBytes),
              "--memory-swap",
              String(options.resources.memoryBytes),
              "--cpus",
              String(options.resources.nanoCpus / 1_000_000_000),
              "--pids-limit",
              String(options.resources.pidsLimit),
              "--label",
              "appstrate.managed=true",
              "--label",
              `appstrate.run=${options.runId}`,
              "--label",
              "appstrate.adapter=browser",
              "--label",
              `appstrate.integration=${options.integrationId}`,
              "--env-file",
              workerEnv.path,
              image,
            ]);
            name = candidate;
            if (!created) {
              throw new Error("BROWSER_UNAVAILABLE: docker create returned no container id");
            }
            containerId = created;
            break;
          } catch (error) {
            if (!isContainerNameConflict(error)) throw error;
          }
        }
        if (!containerId || !name) {
          throw new Error(
            `BROWSER_RESOURCE_LIMIT: all ${maxConcurrent} browser worker slots are occupied`,
          );
        }
        containers.set(id, containerId);
        await exec(["start", containerId]);
      } catch (error) {
        const cleanupTarget = containerId ?? name;
        if (cleanupTarget) await exec(["rm", "-f", cleanupTarget]).catch(() => {});
        containers.delete(id);
        throw error;
      } finally {
        await rm(workerEnv.dir, { recursive: true, force: true }).catch(() => {});
      }

      const endpoint = `http://${name}:8080`;
      const deadline = Date.now() + 30_000;
      let health: {
        workerBuildId: string;
        protocolVersion: number;
        browserRevision: string;
      } | null = null;
      while (Date.now() < deadline) {
        try {
          const response = await fetchFn(`${endpoint}/health`, {
            headers: { Authorization: `Bearer ${authToken}` },
            signal: AbortSignal.timeout(1_000),
          });
          if (response.ok) {
            const body = (await response.json()) as Partial<{
              workerBuildId: string;
              protocolVersion: number;
              browserRevision: string;
            }>;
            if (
              typeof body.workerBuildId === "string" &&
              /^[A-Za-z0-9._@/+:-]{1,128}$/.test(body.workerBuildId) &&
              Number.isInteger(body.protocolVersion) &&
              typeof body.browserRevision === "string" &&
              body.browserRevision.length > 0 &&
              body.browserRevision.length <= 256
            ) {
              health = {
                workerBuildId: body.workerBuildId,
                protocolVersion: body.protocolVersion!,
                browserRevision: body.browserRevision,
              };
              break;
            }
          }
        } catch {
          // Container DNS/listener may not exist yet.
        }
        if (!health) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!health) {
        const cleanupTarget = containerId ?? name;
        if (cleanupTarget) await exec(["rm", "-f", cleanupTarget]).catch(() => {});
        containers.delete(id);
        throw new Error("BROWSER_UNAVAILABLE: docker browser worker did not become healthy");
      }
      return {
        id,
        endpoint,
        authToken,
        workerBuildId: health.workerBuildId,
        protocolVersion: health.protocolVersion,
        browserRevision: health.browserRevision,
        diagnosticId: containerId?.slice(0, 12) ?? hostname(),
      };
    },
    async stop(handle) {
      const containerId = containers.get(handle.id);
      if (!containerId) return;
      await exec(["rm", "-f", containerId]).catch(() => {});
      containers.delete(handle.id);
    },
    async shutdown() {
      for (const [id, containerId] of containers) {
        await exec(["rm", "-f", containerId]).catch(() => {});
        containers.delete(id);
      }
    },
  };
}

registerBrowserProvider({ id: "docker", create: () => createDockerBrowserProvider() });
