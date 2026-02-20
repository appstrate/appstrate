const DOCKER_SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";

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
  networkId?: string;
  networkAlias?: string;
  extraHosts?: string[];
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
    HostConfig: {
      Memory: options.memory ?? 1024 * 1024 * 1024,
      NanoCpus: options.nanoCpus ?? 2_000_000_000,
      AutoRemove: false,
      NetworkMode: options.networkId ?? "bridge",
      ExtraHosts: options.extraHosts ?? [],
    },
    NetworkingConfig: {
      EndpointsConfig: Object.keys(networkingConfig).length > 0 ? networkingConfig : undefined,
    },
    Labels: {
      "appstrate.execution": executionId,
      "appstrate.adapter": options.adapterName,
      "appstrate.managed": "true",
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
 * Inject a single file into a container using Docker's archive API.
 * Creates a minimal tar archive and PUTs it to /containers/{id}/archive.
 * Must be called after createContainer() and before startContainer().
 */
export async function injectFile(
  containerId: string,
  fileName: string,
  fileContent: Buffer,
  targetDir: string,
): Promise<void> {
  const tar = createTarArchive(fileName, fileContent);

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
    throw new Error(`Failed to inject file into container: ${res.status} ${error}`);
  }
}

/** Create a minimal tar archive containing a single file. */
function createTarArchive(fileName: string, content: Buffer): Buffer {
  // Tar header: 512 bytes
  const header = Buffer.alloc(512, 0);

  // name (0-99): file name
  header.write(fileName, 0, Math.min(fileName.length, 100), "utf8");

  // mode (100-107): file permissions
  header.write("0000644\0", 100, 8, "utf8");

  // uid (108-115)
  header.write("0001000\0", 108, 8, "utf8");

  // gid (116-123)
  header.write("0001000\0", 116, 8, "utf8");

  // size (124-135): file size in octal
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, 12, "utf8");

  // mtime (136-147): modification time in octal
  const mtime = Math.floor(Date.now() / 1000);
  header.write(mtime.toString(8).padStart(11, "0") + "\0", 136, 12, "utf8");

  // checksum placeholder (148-155): spaces for calculation
  header.write("        ", 148, 8, "utf8");

  // typeflag (156): '0' for regular file
  header.write("0", 156, 1, "utf8");

  // Compute checksum: sum of all bytes in the header (treating checksum field as spaces)
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i]!;
  }
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");

  // Data blocks: content padded to 512-byte boundary
  const dataBlocks = Math.ceil(content.length / 512);
  const data = Buffer.alloc(dataBlocks * 512, 0);
  content.copy(data);

  // End-of-archive: two 512-byte zero blocks
  const end = Buffer.alloc(1024, 0);

  return Buffer.concat([header, data, end]);
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

export async function getContainerIp(
  containerId: string,
  networkName: string,
): Promise<string | null> {
  const res = await dockerFetch(`/containers/${containerId}/json`);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
  };
  return data.NetworkSettings?.Networks?.[networkName]?.IPAddress ?? null;
}

/**
 * Execute a command inside a running container via Docker exec API.
 * Returns the exit code (0 = success). Uses detached mode + polling
 * so we don't need to parse multiplexed stream output.
 */
export async function execInContainer(containerId: string, cmd: string[]): Promise<number> {
  const createRes = await dockerFetch(`/containers/${containerId}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Cmd: cmd, AttachStdout: false, AttachStderr: false }),
  });

  if (!createRes.ok) {
    const error = await createRes.text();
    throw new Error(`Failed to create exec: ${createRes.status} ${error}`);
  }

  const { Id: execId } = (await createRes.json()) as { Id: string };

  const startRes = await dockerFetch(`/exec/${execId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Detach: true }),
  });

  if (!startRes.ok) {
    const error = await startRes.text();
    throw new Error(`Failed to start exec: ${startRes.status} ${error}`);
  }

  // Poll for completion
  for (let i = 0; i < 30; i++) {
    const inspectRes = await dockerFetch(`/exec/${execId}/json`);
    if (!inspectRes.ok) {
      throw new Error(`Failed to inspect exec: ${inspectRes.status}`);
    }
    const data = (await inspectRes.json()) as { Running: boolean; ExitCode: number };
    if (!data.Running) {
      return data.ExitCode;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return -1; // Polling timeout
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
