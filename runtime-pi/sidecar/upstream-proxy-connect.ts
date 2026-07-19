// SPDX-License-Identifier: Apache-2.0

import type { Socket } from "node:net";

import { netConnectWithTimeout } from "./connect-tunnel.ts";

const MAX_CONNECT_HEADER_BYTES = 16_384;

export class UpstreamProxyConnectError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "UpstreamProxyConnectError";
  }
}

export interface UpstreamProxyConfig {
  readonly host: string;
  readonly port: number;
  readonly authorization: string | null;
}

/** Parse a configured HTTP proxy. Invalid and TLS proxy URLs fail closed. */
export function parseUpstreamProxyUrl(raw: string): UpstreamProxyConfig {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UpstreamProxyConnectError("configured upstream proxy URL is invalid");
  }
  if (url.protocol !== "http:") {
    throw new UpstreamProxyConnectError("only http:// upstream CONNECT proxies are supported");
  }
  if (url.pathname !== "/" || url.search || url.hash || (url.password && !url.username)) {
    throw new UpstreamProxyConnectError(
      "configured upstream proxy must be an origin with optional username/password",
    );
  }
  return {
    host: url.hostname,
    port: Number(url.port || "80"),
    authorization: url.username
      ? "Basic " +
        Buffer.from(
          decodeURIComponent(url.username) + ":" + decodeURIComponent(url.password),
          "utf8",
        ).toString("base64")
      : null,
  };
}

/**
 * Establish a binary-safe CONNECT tunnel through the required organization
 * proxy. The promise resolves only after a 200 response. It never opens a
 * direct connection, so callers cannot accidentally downgrade on failure.
 */
export function connectViaUpstreamProxy(
  target: string,
  proxy: UpstreamProxyConfig,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = netConnectWithTimeout(proxy.port, proxy.host, () => {
      let request = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`;
      if (proxy.authorization) request += `Proxy-Authorization: ${proxy.authorization}\r\n`;
      socket.write(request + "\r\n");
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > MAX_CONNECT_HEADER_BYTES) {
        fail(new UpstreamProxyConnectError("upstream CONNECT response headers are too large"));
        return;
      }
      const combined = Buffer.concat(chunks);
      const headerEnd = combined.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      socket.off("data", onData);
      const statusLine = combined.subarray(0, headerEnd).toString("latin1").split("\r\n")[0] ?? "";
      const statusCode = Number(/^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine)?.[1] ?? 0);
      if (statusCode !== 200) {
        fail(
          new UpstreamProxyConnectError(
            `upstream CONNECT proxy rejected the destination (${statusCode || "invalid response"})`,
            statusCode || undefined,
          ),
        );
        return;
      }
      settled = true;
      const remaining = combined.subarray(headerEnd + 4);
      if (remaining.length > 0) socket.unshift(remaining);
      resolve(socket);
    };

    socket.on("data", onData);
    socket.once("error", (error) => fail(new UpstreamProxyConnectError(error.message)));
    socket.once("close", () => {
      if (!settled) fail(new UpstreamProxyConnectError("upstream proxy closed before CONNECT"));
    });
  });
}
