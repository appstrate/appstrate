// SPDX-License-Identifier: Apache-2.0

import { hostname } from "node:os";
import { logger } from "../lib/logger.ts";
import { getEnv } from "@appstrate/env";
import { classifyDockerNetworkError, createContainerWithImagePull } from "./docker-errors.ts";
import { singleflight } from "../lib/singleflight.ts";

const DOCKER_SOCKET = getEnv().DOCKER_SOCKET;
const DOCKER_API_TIMEOUT_MS = 30_000;

/**
 * Naming prefix for per-run isolation networks. The orchestrator creates
 * `${EXEC_NETWORK_PREFIX}${runId}` for every run, and the cleanup helpers
 * match on this prefix to reclaim orphans from crashed runs. Kept in one
 * place so creator and cleaner can never drift apart — a mismatch would
 * silently leak networks until the address pool is exhausted.
 */
export const EXEC_NETWORK_PREFIX = "appstrate-exec-";

/**
 * Naming prefix for per-run shared workspace volumes. The orchestrator
 * creates `${WORKSPACE_VOLUME_PREFIX}${runId}` alongside the per-run
 * isolation network so the agent container and any opt-in mcp-server
 * runner containers can share a filesystem under `/workspace`. Same
 * shape as `EXEC_NETWORK_PREFIX` so the orphan reaper logic stays
 * symmetric across the two resource types.
 */
export const WORKSPACE_VOLUME_PREFIX = "appstrate-ws-";

/**
 * Name of the shared egress network sidecars (and `skipSidecar` agents)
 * attach to for DNS + internet access. Durable infrastructure: it is
 * resolved **by name at use time** (`ensureNetwork`), never removed by
 * `shutdown()` nor by the boot orphan sweep — several API processes may
 * share one Docker daemon (dev server + integration test app, blue/green
 * deploys), and any of them deleting the network breaks every run of the
 * others until their cached state is refreshed (#834). Docker itself
 * refuses to delete a network with attached endpoints, but the network is
 * empty between runs, so a name-based sweep still races; the only safe
 * policy is to never delete it at all.
 */
export const EGRESS_NETWORK_NAME = "appstrate-egress";

// Support both unix socket (/var/run/docker.sock) and TCP (http://host:port).
// Bun supports fetch() with unix: option for Unix sockets.
// Pass timeoutMs=false for long-running calls (streamLogs, waitForExit).
const DOCKER_TCP = DOCKER_SOCKET.startsWith("http://") || DOCKER_SOCKET.startsWith("https://");

async function assertDockerOk(
  res: Response,
  operation: string,
  allowedStatuses: number[] = [],
): Promise<void> {
  if (res.ok || allowedStatuses.includes(res.status)) return;
  const body = await res.text();
  // Promote known pool-exhaustion failures on network creation to a typed
  // error so the orchestrator can trigger opportunistic cleanup + retry
  // before surfacing the raw Docker body to the user.
  if (operation.startsWith("create network")) {
    const typed = classifyDockerNetworkError(res.status, body);
    if (typed) throw typed;
  }
  throw new Error(`Docker ${operation} failed: ${res.status} ${body}`);
}

async function dockerFetch(
  path: string,
  options: RequestInit = {},
  timeoutMs: number | false = DOCKER_API_TIMEOUT_MS,
): Promise<Response> {
  const url = DOCKER_TCP ? `${DOCKER_SOCKET}${path}` : `http://localhost${path}`;
  return fetch(url, {
    ...options,
    ...(DOCKER_TCP ? {} : { unix: DOCKER_SOCKET }),
    ...(timeoutMs !== false && { signal: AbortSignal.timeout(timeoutMs) }),
  });
}

/**
 * Check if an image exists locally.
 */
async function imageExists(image: string): Promise<boolean> {
  const res = await dockerFetch(`/images/${encodeURIComponent(image)}/json`);
  return res.ok;
}

/**
 * Pulls currently in flight, keyed by image reference. A cold host starting
 * several runs at once would otherwise issue one `POST /images/create` per
 * run for the same reference: the daemon deduplicates the layer downloads
 * internally, but each caller still opens its own progress stream and waits
 * out the full pull. Coalescing bounds the second caller's wait by the first
 * pull instead of a serialised repeat.
 */
const inFlightPulls = new Map<string, Promise<unknown>>();

/**
 * Pull an image from registry. Waits for the pull to complete.
 * Docker pull API streams JSON progress — we consume it fully before resolving.
 *
 * Concurrent calls for the same reference share one pull (see
 * {@link inFlightPulls}); callers for different references run independently.
 */
export function pullImage(image: string): Promise<void> {
  return singleflight(inFlightPulls, image, () => pullImageUncoalesced(image));
}

async function pullImageUncoalesced(image: string): Promise<void> {
  logger.info("Pulling Docker image", { image });

  const res = await dockerFetch(
    `/images/create?fromImage=${encodeURIComponent(image)}`,
    { method: "POST" },
    120_000, // pulls can be slow
  );

  await assertDockerOk(res, `pull image ${image}`);

  // Consume the stream fully — Docker streams JSON progress lines.
  // The API always returns 200; errors (e.g. "manifest unknown") arrive as {"error":"..."} in the stream.
  if (res.body) {
    const decoder = new TextDecoder();
    let lastError: string | undefined;
    for await (const chunk of res.body) {
      const text = decoder.decode(chunk, { stream: true });
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.error) lastError = msg.error;
        } catch {
          // not JSON, ignore
        }
      }
    }
    if (lastError) {
      throw new Error(`Failed to pull image ${image}: ${lastError}`);
    }
  }

  logger.info("Docker image pulled", { image });
}

/**
 * Ensure an image is available locally. Pulls from registry only if missing.
 * Safe for locally-built images (skips pull if already present).
 */
export async function ensureImage(image: string): Promise<void> {
  if (await imageExists(image)) return;
  await pullImage(image);
}

export interface CreateContainerOptions {
  image: string;
  adapterName: string;
  memory?: number;
  nanoCpus?: number;
  pidsLimit?: number;
  networkId?: string;
  networkAlias?: string;
  extraHosts?: string[];
  labels?: Record<string, string>;
  /**
   * Docker `HostConfig.Binds` entries (`/host/path:/container/path[:ro]`).
   * Used by the sidecar to receive the host's Docker socket so it can
   * `docker run` per-integration runner containers (Phase 1.4+). Empty by
   * default for every other workload — agent containers never get this.
   */
  binds?: string[];
  /**
   * Override `User` set in the image. Used by the sidecar to run as
   * root only when it has Docker socket access — keeps the default
   * `USER nobody:nobody` image directive intact for every other path.
   */
  user?: string;
  /**
   * Namespaced `HostConfig.Sysctls` entries. Used by the sidecar to get
   * `net.ipv4.ip_unprivileged_port_start=0` so its transparent egress
   * plane (#779) can bind :53/:443/:80 inside its own netns despite the
   * unconditional `CapDrop: ["ALL"]` — a netns-scoped knob, granting no
   * capability. Empty by default for every other workload.
   */
  sysctls?: Record<string, string>;
}

export async function createContainer(
  runId: string,
  envVars: Record<string, string>,
  options: CreateContainerOptions,
): Promise<string> {
  const containerName = `appstrate-${options.adapterName}-${runId}`;

  const env = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);

  const networkingConfig: Record<string, unknown> = {};
  if (options.networkId && options.networkAlias) {
    networkingConfig[options.networkId] = {
      Aliases: [options.networkAlias],
    };
  } else if (options.networkId) {
    networkingConfig[options.networkId] = {};
  }

  const body = {
    Image: options.image,
    Env: env,
    Tty: false,
    HostConfig: {
      Memory: options.memory ?? 1024 * 1024 * 1024,
      NanoCpus: options.nanoCpus ?? 2_000_000_000,
      SecurityOpt: ["no-new-privileges"],
      CapDrop: ["ALL"],
      PidsLimit: options.pidsLimit ?? 256,
      AutoRemove: false,
      NetworkMode: options.networkId ?? "bridge",
      ExtraHosts: options.extraHosts ?? [],
      ...(options.binds && options.binds.length > 0 ? { Binds: options.binds } : {}),
      ...(options.sysctls && Object.keys(options.sysctls).length > 0
        ? { Sysctls: options.sysctls }
        : {}),
    },
    ...(options.user ? { User: options.user } : {}),
    NetworkingConfig: {
      EndpointsConfig: Object.keys(networkingConfig).length > 0 ? networkingConfig : undefined,
    },
    Labels: {
      "appstrate.run": runId,
      "appstrate.adapter": options.adapterName,
      "appstrate.managed": "true",
      ...options.labels,
    },
  };

  // Pull-on-missing-image: the Engine API never pulls on create, so a host
  // image prune between runs would otherwise fail every run until restart.
  const res = await createContainerWithImagePull(
    () =>
      dockerFetch(`/containers/create?name=${containerName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    () => pullImage(options.image),
    { warn: (msg, data) => logger.warn(msg, { ...data, image: options.image, runId }) },
  );

  await assertDockerOk(res, `create ${options.adapterName} container`);

  const data = (await res.json()) as { Id: string };
  return data.Id;
}

export async function startContainer(containerId: string): Promise<void> {
  const res = await dockerFetch(`/containers/${containerId}/start`, {
    method: "POST",
  });

  // 304 = already started
  await assertDockerOk(res, "start container", [304]);
}

export async function* streamLogs(
  containerId: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  // Do NOT pass `signal` to dockerFetch — Bun's unix-socket fetch does not
  // handle AbortSignal reliably. We use Promise.race below instead.
  const res = await dockerFetch(
    `/containers/${containerId}/logs?follow=true&stdout=true&stderr=true&timestamps=false`,
    { method: "GET" },
    false, // Long-running streaming — no timeout
  );

  await assertDockerOk(res, "stream logs");

  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let remainder = new Uint8Array(0);

  // Race each reader.read() against an abort promise so the loop exits
  // immediately on cancellation (Bun's reader.cancel() hangs on unix sockets).
  type ReadResult = ReturnType<typeof reader.read> extends Promise<infer R> ? R : never;
  const done = { done: true as const, value: undefined } as ReadResult;
  const abortPromise = signal
    ? new Promise<ReadResult>((resolve) => {
        if (signal.aborted) return resolve(done);
        signal.addEventListener("abort", () => resolve(done), { once: true });
      })
    : null;

  try {
    while (true) {
      const { done: eof, value } = abortPromise
        ? await Promise.race([reader.read(), abortPromise])
        : await reader.read();

      if (eof) break;

      // Prepend any leftover bytes from the previous chunk
      let raw: Uint8Array;
      if (remainder.length > 0) {
        const combined = new Uint8Array(remainder.length + value.length);
        combined.set(remainder, 0);
        combined.set(value, remainder.length);
        raw = combined;
        remainder = new Uint8Array(0);
      } else {
        raw = value;
      }

      // Docker multiplexed stream format:
      // Each frame has an 8-byte header: [stream_type(1), 0, 0, 0, size(4)]
      let offset = 0;

      while (offset < raw.length) {
        // Partial header — save for next chunk
        if (offset + 8 > raw.length) {
          remainder = raw.slice(offset);
          break;
        }

        // Read frame header
        const size =
          (raw[offset + 4]! << 24) |
          (raw[offset + 5]! << 16) |
          (raw[offset + 6]! << 8) |
          raw[offset + 7]!;

        offset += 8;

        // Partial body — save header + partial body for next chunk
        if (offset + size > raw.length) {
          remainder = raw.slice(offset - 8);
          break;
        }

        buffer += decoder.decode(raw.slice(offset, offset + size), { stream: true });
        offset += size;
      }

      // Yield complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) yield line;
      }
    }

    // Yield remaining buffer
    if (buffer.trim()) yield buffer;
  } finally {
    // On abort a reader.read() may still be in-flight — skip releaseLock
    // (it throws if a read is pending). The reader/body will be GC'd.
    if (!signal?.aborted) reader.releaseLock();
  }
}

export async function waitForExit(containerId: string): Promise<number> {
  // PATCH (local) — bypass Docker's POST /wait which is blocking long-running.
  // Bun's fetch with unix: option has an internal headers timeout (~5 min) that
  // can't be disabled via signal:undefined or globalThis.fetch replacement.
  // Polling /containers/{id}/json keeps each fetch short (< 30s dockerFetch
  // timeout) and avoids the wall entirely. The CPU cost of polling is
  // negligible compared to the cost of agent runs failing at 5 min.
  //
  // Adaptive backoff: start at 50ms and double up to a 2s cap. Short-lived
  // containers (e.g. the workspace-chown init container on every run start)
  // resolve in one or two cheap inspects instead of eating a fixed 2s sleep,
  // while long-lived agent containers converge to the previous 2s cadence.
  let delayMs = 50;
  const maxDelayMs = 2000;
  while (true) {
    const res = await dockerFetch(`/containers/${containerId}/json`);
    if (!res.ok) {
      // Container removed mid-poll → treat as exit code 137 (SIGKILL).
      if (res.status === 404) return 137;
      await assertDockerOk(res, "inspect container during waitForExit");
    }
    const data = (await res.json()) as { State?: { Status?: string; ExitCode?: number } };
    const status = data.State?.Status;
    if (status === "exited" || status === "dead") {
      return data.State?.ExitCode ?? 0;
    }
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
}

export async function removeContainer(containerId: string): Promise<void> {
  const res = await dockerFetch(`/containers/${containerId}?force=true&v=true`, {
    method: "DELETE",
  });

  await assertDockerOk(res, "remove container", [404]);
}

export async function stopContainer(containerId: string, timeout = 5): Promise<void> {
  const res = await dockerFetch(`/containers/${containerId}/stop?t=${timeout}`, {
    method: "POST",
  });

  await assertDockerOk(res, "stop container", [304, 404]);
}

/**
 * Stop all containers belonging to a run, identified by label.
 * Returns "stopped" if any containers were found, "not_found" otherwise.
 */
export async function stopContainersByRun(
  runId: string,
  timeout = 5,
): Promise<"stopped" | "not_found"> {
  const filters = JSON.stringify({
    label: [`appstrate.run=${runId}`, "appstrate.managed=true"],
  });
  const res = await dockerFetch(`/containers/json?filters=${encodeURIComponent(filters)}`);
  if (!res.ok) return "not_found";
  const containers = (await res.json()) as Array<{ Id: string }>;
  if (containers.length === 0) return "not_found";
  await Promise.allSettled(containers.map((c) => stopContainer(c.Id, timeout)));
  return "stopped";
}

/**
 * Force-remove every container labelled with `appstrate.run=<runId>`
 * (including stopped/dead rows kept by `AutoRemove: false`). Used by
 * the orchestrator's pre-reap to evict zombies still holding a
 * workspace volume open before `removeVolume` is attempted on a
 * quick-restart loop — Docker 409s on attached volumes, so the volume
 * pre-reap is a no-op until the zombie is gone.
 */
export async function removeContainersByRun(runId: string): Promise<number> {
  const filters = JSON.stringify({
    label: [`appstrate.run=${runId}`, "appstrate.managed=true"],
  });
  const res = await dockerFetch(`/containers/json?all=true&filters=${encodeURIComponent(filters)}`);
  if (!res.ok) return 0;
  const containers = (await res.json()) as Array<{ Id: string }>;
  if (containers.length === 0) return 0;
  const results = await Promise.allSettled(containers.map((c) => removeContainer(c.Id)));
  return results.filter((r) => r.status === "fulfilled").length;
}

// --- Docker Network operations ---

export async function createNetwork(
  name: string,
  options?: { internal?: boolean },
): Promise<string> {
  const res = await dockerFetch("/networks/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Name: name,
      CheckDuplicate: true,
      Internal: options?.internal ?? false,
    }),
  });

  await assertDockerOk(res, `create network ${name}`);

  const data = (await res.json()) as { Id: string };
  return data.Id;
}

/**
 * Resolve a network to its ID, creating it if it doesn't exist.
 *
 * This is the single access path for durable infra networks (the shared
 * `appstrate-egress`): resolving **by name at use time** instead of caching
 * an ID at boot means the platform self-heals when the network disappears
 * under a live process — `docker network prune`, a daemon restart, or a
 * concurrent Appstrate instance tearing it down (#834). The next run simply
 * recreates it instead of failing every container create with
 * `network <staleId> not found` until the API is restarted.
 *
 * Inspect-first keeps the steady-state cost to one GET (the network exists
 * for the process's entire lifetime after the first run). The loop absorbs
 * both races: two processes creating concurrently (409 duplicate → re-
 * inspect picks up the winner's network) and inspect/create interleaving
 * with an external delete. Three attempts is plenty — each iteration
 * requires an external actor to flip the network's existence in a
 * millisecond window; genuine failures (pool exhaustion, daemon down)
 * throw immediately via `assertDockerOk`.
 */
export async function ensureNetwork(name: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const inspect = await dockerFetch(`/networks/${encodeURIComponent(name)}`);
    if (inspect.ok) {
      const data = (await inspect.json()) as { Id: string };
      return data.Id;
    }
    await assertDockerOk(inspect, `inspect network ${name}`, [404]);

    const create = await dockerFetch("/networks/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Name: name, CheckDuplicate: true }),
    });
    if (create.ok) {
      const data = (await create.json()) as { Id: string };
      return data.Id;
    }
    // 409 = a concurrent creator won the race — loop back to inspect and
    // adopt their network. Anything else (pool exhausted, daemon error) is
    // a real failure and throws with the pool-exhaustion classification.
    await assertDockerOk(create, `create network ${name}`, [409]);
  }
  throw new Error(`Docker ensure network ${name} failed: inspect/create raced 3 times`);
}

export async function connectContainerToNetwork(
  networkId: string,
  containerId: string,
  aliases?: string[],
): Promise<void> {
  const body: Record<string, unknown> = { Container: containerId };
  if (aliases && aliases.length > 0) {
    body.EndpointConfig = { Aliases: aliases };
  }

  const res = await dockerFetch(`/networks/${networkId}/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  await assertDockerOk(res, "connect container to network");
}

export async function removeNetwork(networkId: string): Promise<void> {
  const res = await dockerFetch(`/networks/${networkId}`, {
    method: "DELETE",
  });

  await assertDockerOk(res, "remove network", [404]);
}

// --- Docker Volume operations ---

/**
 * Create a Docker named volume scoped to a single run. The volume backs
 * `/workspace` on the agent container and (when opt-in via mcp-server
 * `_meta["dev.appstrate/workspace"]`) on per-integration runner
 * containers. Always carries `appstrate.run=<runId>` +
 * `appstrate.managed=true` labels so the orphan reaper can reclaim
 * volumes leaked by crashed runs.
 *
 * `driverOpts` lets the orchestrator request a tmpfs-backed volume
 * (`{ type: "tmpfs", device: "tmpfs", o: "size=512m" }`) in production
 * where workspace contents are ephemeral and RAM-backed cleanup is
 * desirable. Plain local-driver volumes are the default.
 */
export async function createVolume(
  name: string,
  options?: {
    labels?: Record<string, string>;
    driver?: string;
    driverOpts?: Record<string, string>;
  },
): Promise<string> {
  const labels: Record<string, string> = {
    "appstrate.managed": "true",
    ...(options?.labels ?? {}),
  };

  const res = await dockerFetch("/volumes/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Name: name,
      Driver: options?.driver ?? "local",
      DriverOpts: options?.driverOpts ?? {},
      Labels: labels,
    }),
  });

  await assertDockerOk(res, `create volume ${name}`);

  const data = (await res.json()) as { Name: string };
  return data.Name;
}

/**
 * Remove a Docker volume by name. Returns silently on 404 (already gone)
 * and 409 (still in use — Docker refuses to delete attached volumes,
 * caller is responsible for ensuring no container references it).
 */
export async function removeVolume(name: string): Promise<void> {
  const res = await dockerFetch(`/volumes/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });

  await assertDockerOk(res, "remove volume", [404, 409]);
}

/**
 * List + remove orphaned per-run workspace volumes (`appstrate-ws-*`).
 * Safe to call mid-operation: Docker refuses to delete volumes that
 * still have containers attached, so live runs are untouched. Used by
 * the boot-time orphan sweep alongside `cleanupOrphanedNetworks`.
 */
export async function cleanupOrphanedVolumes(): Promise<number> {
  return removeVolumesMatching((name) => name.startsWith(WORKSPACE_VOLUME_PREFIX));
}

/**
 * Run a short-lived container synchronously and clean it up. Used by
 * the orchestrator for init steps that don't fit the long-lived
 * agent/sidecar lifecycle: setting volume ownership, pre-warming a
 * mount, etc. Auto-removes on exit; surfaces a non-zero exit code as
 * a typed error so callers can fail the run rather than silently
 * proceeding with a half-initialised volume.
 *
 * Pull-on-miss is left to the caller (call `ensureImage` first if the
 * image isn't guaranteed present) — most call sites use a baked-in
 * tiny image (busybox/alpine) that's pre-pulled at boot.
 */
export async function runEphemeralCommand(options: {
  image: string;
  cmd: string[];
  binds?: string[];
  runId?: string;
  /**
   * Ceiling on the post-pull lifecycle (create + start + wait).
   * Defaults to 60s — short enough to fail a stuck init before it
   * blocks the orchestrator. The preceding `ensureImage` pull is NOT
   * bounded by this (Docker's pull has no abort handle here); a cold
   * pull eats into the budget so `wait` may get 0ms and time out
   * immediately, but the pull itself runs to completion or its own
   * failure.
   */
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  await ensureImage(options.image);
  // Start the clock AFTER the (unbounded) pull so a cold pull doesn't
  // silently consume the create+start+wait budget.
  const deadline = Date.now() + timeoutMs;

  const createBody = JSON.stringify({
    Image: options.image,
    Cmd: options.cmd,
    Tty: false,
    HostConfig: {
      // AutoRemove deliberately OFF — Docker removes the container
      // the moment its main process exits, racing the `waitForExit`
      // poll (which inspects /containers/<id>/json every 2s). Without
      // the container row, the poll sees 404 and reports the
      // sentinel exit code 137 even on a clean `true` invocation.
      // We remove explicitly after `waitForExit` resolves so the
      // exit code is always observable.
      AutoRemove: false,
      SecurityOpt: ["no-new-privileges"],
      CapDrop: ["ALL"],
      // chown needs CHOWN cap restored — narrow grant for the init
      // step; runEphemeralCommand has only one caller today (the
      // workspace-volume init), so this stays trivially auditable.
      // If more callers appear with different cap needs, surface
      // `capAdd` through the options.
      CapAdd: ["CHOWN", "FOWNER"],
      ...(options.binds && options.binds.length > 0 ? { Binds: options.binds } : {}),
    },
    Labels: {
      "appstrate.managed": "true",
      "appstrate.adapter": "ephemeral",
      ...(options.runId ? { "appstrate.run": options.runId } : {}),
    },
  });

  // `ensureImage` above closes the common case, but a host prune can still
  // land between that check and this create — heal the same way.
  const createRes = await createContainerWithImagePull(
    () =>
      dockerFetch("/containers/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: createBody,
      }),
    () => pullImage(options.image),
    {
      warn: (msg, data) =>
        logger.warn(msg, { ...data, image: options.image, runId: options.runId }),
    },
  );
  await assertDockerOk(createRes, "create ephemeral container");
  const { Id: containerId } = (await createRes.json()) as { Id: string };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const startRes = await dockerFetch(`/containers/${containerId}/start`, {
      method: "POST",
    });
    await assertDockerOk(startRes, "start ephemeral container");

    const remaining = deadline - Date.now();
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Ephemeral container ${options.image} timed out after ${timeoutMs}ms (cmd: ${options.cmd.join(" ")})`,
            ),
          ),
        Math.max(remaining, 0),
      );
    });
    const exitCode = await Promise.race([waitForExit(containerId), timeoutPromise]);
    if (exitCode !== 0) {
      throw new Error(
        `Ephemeral container ${options.image} exited with code ${exitCode} (cmd: ${options.cmd.join(" ")})`,
      );
    }
  } finally {
    // Clear the timeout so a resolved-on-exit call doesn't keep a timer
    // (and the event loop) alive until the deadline, and always clean
    // up the container — even on non-zero exit the caller sees the
    // throw and we leave no leak behind.
    if (timer) clearTimeout(timer);
    await removeContainer(containerId).catch(() => {});
  }
}

async function removeVolumesMatching(predicate: (name: string) => boolean): Promise<number> {
  const res = await dockerFetch("/volumes");
  if (!res.ok) return 0;

  const data = (await res.json()) as { Volumes?: Array<{ Name: string }> | null };
  const volumes = data.Volumes ?? [];
  const targets = volumes.filter((v) => predicate(v.Name));
  if (targets.length === 0) return 0;

  const results = await Promise.allSettled(targets.map((v) => removeVolume(v.Name)));
  return results.filter((r) => r.status === "fulfilled").length;
}

// --- Orphaned container cleanup ---

export async function cleanupOrphanedContainers(): Promise<{
  containers: number;
  networks: number;
  volumes: number;
}> {
  // Clean up orphaned containers
  const filters = JSON.stringify({ label: ["appstrate.managed=true"] });
  const res = await dockerFetch(`/containers/json?all=true&filters=${encodeURIComponent(filters)}`);

  await assertDockerOk(res, "list managed containers");

  const containers = (await res.json()) as Array<{
    Id: string;
    Labels: Record<string, string>;
  }>;

  // Remove all containers in parallel (force=true handles running containers)
  if (containers.length > 0) {
    await Promise.allSettled(containers.map((c) => removeContainer(c.Id)));
  }

  // Clean up orphaned networks by listing Docker networks directly.
  // This catches networks that leaked when containers were already removed
  // (crash, kill -9, Docker auto-cleanup) but their network persisted.
  const networkCount = await cleanupOrphanedNetworks();

  // Workspace volumes leak in the same way networks do — a run that
  // exits hard before its orchestrator can call removeIsolationBoundary
  // leaves the named volume behind. Reap after the container sweep so
  // Docker's "volume in use" check (409) doesn't refuse the delete.
  const volumeCount = await cleanupOrphanedVolumes();

  return { containers: containers.length, networks: networkCount, volumes: volumeCount };
}

/**
 * Remove orphan per-run networks (`appstrate-exec-*`) without touching the
 * shared infra networks — {@link EGRESS_NETWORK_NAME} is durable and never
 * swept (#834: a second API process booting against the same daemon used to
 * delete it out from under the first one's live runs). Safe to call
 * mid-operation: Docker refuses to delete networks that still have attached
 * endpoints (live runs), so only truly abandoned networks from crashed runs
 * get reclaimed. Called from the boot sweep and as the opportunistic
 * recovery path when `createNetwork` hits address-pool exhaustion —
 * reclaiming even one orphan is often enough to unblock the retry.
 */
export async function cleanupOrphanedNetworks(): Promise<number> {
  return removeNetworksMatching((name) => name.startsWith(EXEC_NETWORK_PREFIX));
}

async function removeNetworksMatching(predicate: (name: string) => boolean): Promise<number> {
  const res = await dockerFetch("/networks");
  if (!res.ok) return 0;

  const networks = (await res.json()) as Array<{ Id: string; Name: string }>;
  const targets = networks.filter((n) => predicate(n.Name));
  if (targets.length === 0) return 0;

  const results = await Promise.allSettled(targets.map((n) => removeNetwork(n.Id)));
  return results.filter((r) => r.status === "fulfilled").length;
}

// --- Platform network auto-detection ---

let platformNetworkCache: { networkId: string; hostname: string } | null | undefined;

/**
 * Detect the Docker network the platform container is connected to.
 * Uses os.hostname() (Docker sets hostname = container ID prefix) to inspect
 * ourselves and find the first non-default-bridge network.
 * Returns null when running outside Docker (local dev).
 * Result is cached after the first call.
 */
export async function detectPlatformNetwork(): Promise<{
  networkId: string;
  hostname: string;
} | null> {
  if (platformNetworkCache !== undefined) return platformNetworkCache;

  try {
    const containerName = hostname();
    const res = await dockerFetch(`/containers/${containerName}/json`);

    if (!res.ok) {
      // 404 = not running in Docker (local dev)
      platformNetworkCache = null;
      return null;
    }

    const data = (await res.json()) as {
      Config?: { Hostname?: string };
      NetworkSettings?: {
        Networks?: Record<
          string,
          { NetworkID?: string; Aliases?: string[] | null; IPAddress?: string; Gateway?: string }
        >;
      };
    };

    const networks = data.NetworkSettings?.Networks;
    if (!networks) {
      platformNetworkCache = null;
      return null;
    }

    // Find the first non-default network (skip "bridge" and "host")
    const DEFAULT_NETWORKS = new Set(["bridge", "host", "none"]);
    for (const [name, info] of Object.entries(networks)) {
      if (DEFAULT_NETWORKS.has(name) || !info.NetworkID) continue;

      // Use the first alias or fall back to the container hostname
      const dnsName = info.Aliases?.[0] ?? data.Config?.Hostname ?? containerName;

      platformNetworkCache = { networkId: info.NetworkID, hostname: dnsName };
      logger.info("Detected platform Docker network", {
        network: name,
        networkId: info.NetworkID,
        hostname: dnsName,
      });
      return platformNetworkCache;
    }

    platformNetworkCache = null;
    return null;
  } catch {
    platformNetworkCache = null;
    return null;
  }
}
