// SPDX-License-Identifier: Apache-2.0

import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";
import type { IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import {
  isBlockedHost,
  OUTBOUND_TIMEOUT_MS,
  HOP_BY_HOP_HEADERS,
  type SidecarConfig,
} from "./helpers.ts";
import { logger } from "./logger.ts";

export interface ForwardProxyDeps {
  config: SidecarConfig;
  listenPort?: number; // default 8081 — tests use 0 (ephemeral)
  listenHost?: string; // default "0.0.0.0" — tests use "127.0.0.1"
  isBlockedHostFn?: typeof isBlockedHost; // injectable for testing pass-through
}

export interface ForwardProxyResult {
  server: HttpServer;
  ready: Promise<void>; // resolves when the port is bound
  readySync: boolean; // synchronous check
  address: () => { port: number; host: string };
}

export function createForwardProxy(deps: ForwardProxyDeps): ForwardProxyResult {
  const { config } = deps;
  const listenPort = deps.listenPort ?? 8081;
  const listenHost = deps.listenHost ?? "0.0.0.0";
  const isBlockedHostFn = deps.isBlockedHostFn ?? isBlockedHost;

  const CONNECT_TIMEOUT_MS = 10_000;
  const SOCKET_IDLE_TIMEOUT_MS = 120_000; // 2 min idle → destroy tunnel
  const MAX_CONNECT_HEADER_SIZE = 16_384; // 16 KB — CONNECT response headers should be tiny

  function getUpstreamProxy(): { host: string; port: number; auth: string | null } | null {
    if (!config.proxyUrl) return null;
    try {
      const url = new URL(config.proxyUrl);
      // HTTPS upstream proxies are not supported — the forward proxy connects via plain TCP.
      if (url.protocol === "https:") {
        logger.warn(
          "HTTPS upstream proxy not supported, connection will use plain TCP — proxy may reject",
          { proxyUrl: url.origin },
        );
      }
      return {
        host: url.hostname,
        port: parseInt(url.port) || (url.protocol === "https:" ? 443 : 80),
        auth: url.username
          ? "Basic " +
            btoa(decodeURIComponent(url.username) + ":" + decodeURIComponent(url.password))
          : null,
      };
    } catch {
      logger.warn("Invalid proxy URL, ignoring", { proxyUrl: config.proxyUrl });
      return null;
    }
  }

  function relay(s1: Socket, s2: Socket): void {
    s1.pipe(s2);
    s2.pipe(s1);
    // Idle timeout — destroys both sides if no data flows for SOCKET_IDLE_TIMEOUT_MS
    s1.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => {
      s1.destroy();
    });
    s2.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => {
      s2.destroy();
    });
    s1.on("error", () => s2.destroy());
    s2.on("error", () => s1.destroy());
    s1.on("close", () => {
      if (!s2.destroyed) s2.destroy();
    });
    s2.on("close", () => {
      if (!s1.destroyed) s1.destroy();
    });
  }

  /** Strip hop-by-hop headers + Connection-listed headers from incoming request. */
  function forwardHeaders(
    raw: IncomingMessage["headers"],
  ): Record<string, string | string[] | undefined> {
    // Collect any extra hop-by-hop names declared in the Connection header
    const connectionExtra = new Set(
      (typeof raw.connection === "string" ? raw.connection : "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    );

    const out: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(raw)) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower) || connectionExtra.has(lower)) continue;
      out[key] = value;
    }
    return out;
  }

  /** Connect with a timeout — destroys the socket if it doesn't connect in time. */
  function netConnectWithTimeout(port: number, host: string, onConnect: () => void): Socket {
    const socket = netConnect(port, host, () => {
      clearTimeout(timer);
      onConnect();
    });
    const timer = setTimeout(() => {
      socket.destroy(new Error(`Connect timeout after ${CONNECT_TIMEOUT_MS}ms to ${host}:${port}`));
    }, CONNECT_TIMEOUT_MS);
    socket.on("close", () => clearTimeout(timer));
    return socket;
  }

  // The platform API is a trusted destination: the agent can only send
  // HMAC-signed messages there (the run secret is scoped to a single run).
  // In local dev the platform URL resolves to `host.docker.internal`, which
  // is in the SSRF blocklist — exempt that specific host so sink/finalize
  // traffic can reach the platform. Other internal hosts remain blocked.
  //
  // `config` is mutated at runtime via POST /configure (pool sidecars start
  // with a placeholder URL and receive the real one on acquisition), so
  // recompute the allowed platform host on every request.
  function getPlatformHost(): string | null {
    try {
      return new URL(config.platformApiUrl).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  function isAllowedHost(hostname: string): boolean {
    const h = hostname.toLowerCase();
    const platformHost = getPlatformHost();
    if (platformHost && h === platformHost) return true;
    return !isBlockedHostFn(h);
  }

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    // Regular HTTP requests (non-CONNECT) — forward through upstream or direct
    const targetUrl = req.url;
    if (!targetUrl) {
      res.writeHead(400);
      res.end("Missing URL");
      return;
    }

    const upstream = getUpstreamProxy();

    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      res.writeHead(400);
      res.end("Invalid URL");
      return;
    }

    // SSRF protection — block requests to internal/private networks,
    // except the trusted platform API (handles local-dev host.docker.internal).
    if (!isAllowedHost(parsed.hostname)) {
      res.writeHead(403);
      res.end("Blocked: internal network");
      return;
    }

    const cleaned = forwardHeaders(req.headers);

    const options = upstream
      ? {
          hostname: upstream.host,
          port: upstream.port,
          path: targetUrl,
          method: req.method,
          headers: {
            ...cleaned,
            host: parsed.host,
            ...(upstream.auth ? { "Proxy-Authorization": upstream.auth } : {}),
          },
        }
      : {
          hostname: parsed.hostname,
          port: parseInt(parsed.port) || 80,
          path: parsed.pathname + parsed.search,
          method: req.method,
          headers: { ...cleaned, host: parsed.host },
        };

    const proxyReq = httpRequest(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    });

    // Timeout — abort if the target or upstream proxy hangs
    proxyReq.setTimeout(OUTBOUND_TIMEOUT_MS, () => {
      proxyReq.destroy(new Error(`Request timeout after ${OUTBOUND_TIMEOUT_MS}ms`));
    });

    // Clean up if either side breaks
    req.on("error", () => {
      proxyReq.destroy();
    });
    res.on("error", () => {
      proxyReq.destroy();
    });
    proxyReq.on("error", (err) => {
      logger.error("Forward proxy HTTP error", { target: targetUrl, error: err.message });
      if (!res.headersSent) res.writeHead(502);
      res.end("Proxy error");
    });

    req.pipe(proxyReq);
  });

  // CONNECT handler — HTTPS tunneling
  server.on("connect", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const target = req.url ?? "";

    // Parse host:port — handles IPv6 bracket notation ([::1]:443)
    let host: string;
    let port: number;
    if (target.startsWith("[")) {
      const closeBracket = target.indexOf("]");
      if (closeBracket === -1) {
        clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        clientSocket.destroy();
        return;
      }
      host = target.slice(1, closeBracket);
      const rest = target.slice(closeBracket + 1);
      port = rest.startsWith(":") ? parseInt(rest.slice(1)) || 443 : 443;
    } else {
      const colonIdx = target.lastIndexOf(":");
      if (colonIdx === -1) {
        host = target;
        port = 443;
      } else {
        host = target.slice(0, colonIdx);
        port = parseInt(target.slice(colonIdx + 1)) || 443;
      }
    }

    if (!host) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    // SSRF protection — block CONNECT tunnels to internal/private networks,
    // except the trusted platform API (handles local-dev host.docker.internal).
    if (!isAllowedHost(host)) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    const upstream = getUpstreamProxy();

    if (upstream) {
      // Chain through authenticated upstream proxy
      const proxySocket = netConnectWithTimeout(upstream.port, upstream.host, () => {
        let connectReq = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`;
        if (upstream.auth) connectReq += `Proxy-Authorization: ${upstream.auth}\r\n`;
        connectReq += "\r\n";
        proxySocket.write(connectReq);
      });

      // Accumulate raw Buffers to avoid corrupting binary data after headers
      const chunks: Buffer[] = [];
      let bufferSize = 0;
      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        bufferSize += chunk.length;

        // Guard against oversized headers from misbehaving upstream
        if (bufferSize > MAX_CONNECT_HEADER_SIZE) {
          logger.error("CONNECT header too large from upstream", { target, size: bufferSize });
          proxySocket.off("data", onData);
          clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          clientSocket.destroy();
          proxySocket.destroy();
          return;
        }

        const combined = Buffer.concat(chunks);
        const headerEnd = combined.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        // Remove listener BEFORE relay to avoid writing data twice
        proxySocket.off("data", onData);

        const headerStr = combined.subarray(0, headerEnd).toString();
        const status = parseInt(headerStr.split(" ")[1] ?? "0");
        if (status === 200) {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          const remaining = combined.subarray(headerEnd + 4);
          if (remaining.length) clientSocket.write(remaining);
          if (head.length) proxySocket.write(head);
          relay(clientSocket, proxySocket);
        } else {
          logger.warn("Upstream CONNECT rejected", { target, status });
          clientSocket.write(`HTTP/1.1 ${status} Upstream Rejected\r\n\r\n`);
          clientSocket.destroy();
          proxySocket.destroy();
        }
      };
      proxySocket.on("data", onData);
      proxySocket.on("error", (err) => {
        logger.error("CONNECT upstream error", { target, error: err.message });
        clientSocket.destroy();
      });
      clientSocket.on("error", () => proxySocket.destroy());
    } else {
      // Direct connection (pass-through)
      const targetSocket = netConnectWithTimeout(port, host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) targetSocket.write(head);
        relay(clientSocket, targetSocket);
      });
      targetSocket.on("error", (err) => {
        logger.error("CONNECT direct error", { target, error: err.message });
        clientSocket.destroy();
      });
      clientSocket.on("error", () => targetSocket.destroy());
    }
  });

  server.on("error", (err) => {
    logger.error("Forward proxy server error", { error: err.message });
  });

  let readySyncFlag = false;
  const readyPromise = new Promise<void>((resolve) => {
    server.listen(listenPort, listenHost, () => {
      readySyncFlag = true;
      resolve();
    });
  });

  return {
    server,
    ready: readyPromise,
    get readySync() {
      return readySyncFlag;
    },
    address: () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        return { port: addr.port, host: addr.address };
      }
      return { port: listenPort, host: listenHost };
    },
  };
}
