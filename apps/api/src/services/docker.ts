const DOCKER_SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const CLAUDE_CODE_RUNTIME_IMAGE = "appstrate-claude-code:latest";

// Bun supports fetch() with unix: option for Unix sockets
async function dockerFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    ...options,
    // @ts-expect-error Bun-specific unix socket option
    unix: DOCKER_SOCKET,
  });
}

export async function createClaudeCodeContainer(
  executionId: string,
  envVars: Record<string, string>,
): Promise<string> {
  const containerName = `appstrate-cc-${executionId}`;

  const env = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);

  const body = {
    Image: CLAUDE_CODE_RUNTIME_IMAGE,
    Env: env,
    Tty: false,
    HostConfig: {
      Memory: 1024 * 1024 * 1024,
      NanoCpus: 2_000_000_000,
      AutoRemove: false,
      NetworkMode: "bridge",
    },
    Labels: {
      "appstrate.execution": executionId,
      "appstrate.adapter": "claude-code",
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
    throw new Error(`Failed to create claude-code container: ${res.status} ${error}`);
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

export async function* streamLogs(containerId: string): AsyncGenerator<string> {
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

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

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
    reader.releaseLock();
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

export async function stopContainer(containerId: string, timeout = 5): Promise<void> {
  const res = await dockerFetch(`/containers/${containerId}/stop?t=${timeout}`, {
    method: "POST",
  });

  if (!res.ok && res.status !== 304 && res.status !== 404) {
    const error = await res.text();
    throw new Error(`Failed to stop container: ${res.status} ${error}`);
  }
}
