import { hostname } from "node:os";
import { logger } from "../lib/logger.ts";
import { getEnv } from "@appstrate/env";

const DOCKER_SOCKET = getEnv().DOCKER_SOCKET;

// Bun supports fetch() with unix: option for Unix sockets
async function dockerFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...options,
    unix: DOCKER_SOCKET,
  });
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
  portBindings?: Record<string, Array<{ HostPort: string }>>;
  exposedPorts?: Record<string, object>;
  labels?: Record<string, string>;
}

export async function createContainer(
  executionId: string,
  envVars: Record<string, string>,
  options: CreateContainerOptions,
): Promise<string> {
  const containerName = `appstrate-${options.adapterName}-${executionId}`;

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
    ExposedPorts: options.exposedPorts,
    HostConfig: {
      Memory: options.memory ?? 1024 * 1024 * 1024,
      NanoCpus: options.nanoCpus ?? 2_000_000_000,
      SecurityOpt: ["no-new-privileges"],
      CapDrop: ["ALL"],
      PidsLimit: options.pidsLimit ?? 256,
      AutoRemove: false,
      NetworkMode: options.networkId ?? "bridge",
      ExtraHosts: options.extraHosts ?? [],
      PortBindings: options.portBindings,
    },
    NetworkingConfig: {
      EndpointsConfig: Object.keys(networkingConfig).length > 0 ? networkingConfig : undefined,
    },
    Labels: {
      "appstrate.execution": executionId,
      "appstrate.adapter": options.adapterName,
      "appstrate.managed": "true",
      ...options.labels,
    },
  };

  const res = await dockerFetch(`/containers/create?name=${containerName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to create ${options.adapterName} container: ${res.status} ${error}`);
  }

  const data = (await res.json()) as { Id: string };
  return data.Id;
}

export async function startContainer(containerId: string): Promise<void> {
  const res = await dockerFetch(`/containers/${containerId}/start`, {
    method: "POST",
  });

  if (!res.ok && res.status !== 304) {
    // 304 = already started
    const error = await res.text();
    throw new Error(`Failed to start container: ${res.status} ${error}`);
  }
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
  );

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to stream logs: ${res.status} ${error}`);
  }

  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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

      // Docker multiplexed stream format:
      // Each frame has an 8-byte header: [stream_type(1), 0, 0, 0, size(4)]
      // For simplicity, strip the 8-byte headers and decode as text
      const raw = value;
      let offset = 0;

      while (offset < raw.length) {
        if (offset + 8 > raw.length) break;

        // Read frame header
        const size =
          (raw[offset + 4]! << 24) |
          (raw[offset + 5]! << 16) |
          (raw[offset + 6]! << 8) |
          raw[offset + 7]!;

        offset += 8;

        if (offset + size > raw.length) {
          // Partial frame, decode what we have
          buffer += decoder.decode(raw.slice(offset), { stream: true });
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
  const res = await dockerFetch(`/containers/${containerId}/wait`, {
    method: "POST",
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to wait for container: ${res.status} ${error}`);
  }

  const data = (await res.json()) as { StatusCode: number };
  return data.StatusCode;
}

export async function removeContainer(containerId: string): Promise<void> {
  const res = await dockerFetch(`/containers/${containerId}?force=true&v=true`, {
    method: "DELETE",
  });

  if (!res.ok && res.status !== 404) {
    const error = await res.text();
    throw new Error(`Failed to remove container: ${res.status} ${error}`);
  }
}

/**
 * Inject files into a container using a single tar archive via Docker's archive API.
 * Must be called after createContainer() and before startContainer().
 */
export async function injectFiles(
  containerId: string,
  files: Array<{ name: string; content: Buffer }>,
  targetDir: string,
): Promise<void> {
  if (files.length === 0) return;

  const tar = createTarArchive(files);

  const res = await dockerFetch(
    `/containers/${containerId}/archive?path=${encodeURIComponent(targetDir)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/x-tar" },
      body: tar,
    },
  );

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to inject files into container: ${res.status} ${error}`);
  }
}

/** Create a tar header for a single file entry. */
function createTarHeader(fileName: string, contentLength: number): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(fileName, 0, Math.min(fileName.length, 100), "utf8");
  header.write("0000644\0", 100, 8, "utf8");
  header.write("0001000\0", 108, 8, "utf8");
  header.write("0001000\0", 116, 8, "utf8");
  header.write(contentLength.toString(8).padStart(11, "0") + "\0", 124, 12, "utf8");
  const mtime = Math.floor(Date.now() / 1000);
  header.write(mtime.toString(8).padStart(11, "0") + "\0", 136, 12, "utf8");
  header.write("        ", 148, 8, "utf8");
  header.write("0", 156, 1, "utf8");

  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i]!;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");

  return header;
}

/** Create a tar archive containing one or more files. */
function createTarArchive(files: Array<{ name: string; content: Buffer }>): Buffer {
  const blocks: Buffer[] = [];

  for (const file of files) {
    blocks.push(createTarHeader(file.name, file.content.length));
    const dataBlocks = Math.ceil(file.content.length / 512);
    const data = Buffer.alloc(dataBlocks * 512, 0);
    file.content.copy(data);
    blocks.push(data);
  }

  // End-of-archive: two 512-byte zero blocks
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

export async function stopContainer(containerId: string, timeout = 5): Promise<void> {
  const res = await dockerFetch(`/containers/${containerId}/stop?t=${timeout}`, {
    method: "POST",
  });

  if (!res.ok && res.status !== 304 && res.status !== 404) {
    const error = await res.text();
    throw new Error(`Failed to stop container: ${res.status} ${error}`);
  }
}

/**
 * Stop all containers belonging to an execution, identified by label.
 * Returns "stopped" if any containers were found, "not_found" otherwise.
 */
export async function stopContainersByExecution(
  executionId: string,
  timeout = 5,
): Promise<"stopped" | "not_found"> {
  const filters = JSON.stringify({
    label: [`appstrate.execution=${executionId}`, "appstrate.managed=true"],
  });
  const res = await dockerFetch(`/containers/json?filters=${encodeURIComponent(filters)}`);
  if (!res.ok) return "not_found";
  const containers = (await res.json()) as Array<{ Id: string }>;
  if (containers.length === 0) return "not_found";
  await Promise.allSettled(containers.map((c) => stopContainer(c.Id, timeout)));
  return "stopped";
}

// --- Docker Network operations ---

export async function createNetwork(name: string): Promise<string> {
  const res = await dockerFetch("/networks/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Name: name, CheckDuplicate: true }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to create network ${name}: ${res.status} ${error}`);
  }

  const data = (await res.json()) as { Id: string };
  return data.Id;
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

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to connect container to network: ${res.status} ${error}`);
  }
}

/**
 * Get the host-mapped port for a container's exposed port.
 * Returns the host port number, or null if no mapping exists.
 */
export async function getContainerHostPort(
  containerId: string,
  containerPort: string,
): Promise<number | null> {
  const res = await dockerFetch(`/containers/${containerId}/json`);
  if (!res.ok) return null;

  const data = (await res.json()) as {
    NetworkSettings?: {
      Ports?: Record<string, Array<{ HostPort: string }> | null>;
    };
  };

  const portInfo = data.NetworkSettings?.Ports?.[containerPort]?.[0];
  if (!portInfo?.HostPort) return null;
  return parseInt(portInfo.HostPort, 10);
}

export async function removeNetwork(networkId: string): Promise<void> {
  const res = await dockerFetch(`/networks/${networkId}`, {
    method: "DELETE",
  });

  if (!res.ok && res.status !== 404) {
    const error = await res.text();
    throw new Error(`Failed to remove network: ${res.status} ${error}`);
  }
}

// --- Orphaned container cleanup ---

export async function cleanupOrphanedContainers(): Promise<{
  containers: number;
  networks: number;
}> {
  // Clean up orphaned containers
  const filters = JSON.stringify({ label: ["appstrate.managed=true"] });
  const res = await dockerFetch(`/containers/json?all=true&filters=${encodeURIComponent(filters)}`);

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to list managed containers: ${res.status} ${error}`);
  }

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

  return { containers: containers.length, networks: networkCount };
}

/**
 * List all Docker networks matching `appstrate-exec-*` and remove them.
 * This is safe to call at startup because no executions should be running.
 */
async function cleanupOrphanedNetworks(): Promise<number> {
  const res = await dockerFetch("/networks");
  if (!res.ok) return 0;

  const networks = (await res.json()) as Array<{ Id: string; Name: string }>;
  const orphaned = networks.filter((n) => n.Name.startsWith("appstrate-exec-"));

  if (orphaned.length === 0) return 0;

  const results = await Promise.allSettled(orphaned.map((n) => removeNetwork(n.Id)));
  return results.filter((r) => r.status === "fulfilled").length;
}

// --- Platform network auto-detection ---

let platformNetworkCache:
  | { networkId: string; hostname: string; gatewayIp: string }
  | null
  | undefined;

/**
 * Get the address to reach Docker host-mapped ports.
 * Returns "localhost" in local dev, or the Docker gateway IP when the platform
 * itself runs inside a container (e.g. Coolify).
 * Result is cached after the first call.
 */
export async function getDockerHostAddress(): Promise<string> {
  const platform = await detectPlatformNetwork();
  return platform?.gatewayIp || "localhost";
}

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
  gatewayIp: string;
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

      const gatewayIp = info.Gateway ?? "";
      platformNetworkCache = { networkId: info.NetworkID, hostname: dnsName, gatewayIp };
      logger.info("Detected platform Docker network", {
        network: name,
        networkId: info.NetworkID,
        hostname: dnsName,
        gatewayIp,
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
