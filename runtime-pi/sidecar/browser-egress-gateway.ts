// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import { isBlockedHost, resolveAndCheckHost, type HostResolver } from "./helpers.ts";
import { netConnectWithTimeout, parseConnectTarget, relaySockets } from "./connect-tunnel.ts";
import {
  connectViaUpstreamProxy,
  parseUpstreamProxyUrl,
  type UpstreamProxyConfig,
} from "./upstream-proxy-connect.ts";

export type BrowserGatewayEventKind = "gateway-allowed" | "gateway-denied" | "gateway-proxy-failed";

export interface BrowserGatewayEvent {
  readonly kind: BrowserGatewayEventKind;
  /** Host and port only; paths, queries, headers, and bodies never exist here. */
  readonly target: string;
  readonly reason?: string;
}

export interface BrowserEgressGatewayOptions {
  readonly authToken: string;
  readonly allowedOrigins: readonly string[];
  readonly upstreamProxyUrl?: string;
  readonly host?: string;
  readonly port?: number;
  readonly maxTunnelBytes?: number;
  readonly maxConcurrentTunnels?: number;
  readonly idleTunnelMs?: number;
  readonly isBlockedHostFn?: typeof isBlockedHost;
  readonly resolveHostFn?: HostResolver;
  readonly onEvent?: (event: BrowserGatewayEvent) => void;
}

export interface BrowserEgressGatewayHandle {
  readonly ready: Promise<void>;
  address(): { host: string; port: number };
  proxyUrl(): string;
  close(): Promise<void>;
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice("Bearer ".length), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function allowedTargets(origins: readonly string[]): Set<string> {
  const targets = new Set<string>();
  for (const origin of origins) {
    const url = new URL(origin);
    const port = Number(url.port || "443");
    targets.add(`${url.hostname.toLowerCase()}:${port}`);
  }
  return targets;
}

function addressTarget(address: string, port: number): string {
  return `${address.includes(":") ? `[${address}]` : address}:${port}`;
}

function applyByteLimit(a: Socket, b: Socket, maximum: number): void {
  let total = 0;
  const account = (chunk: Buffer) => {
    total += chunk.length;
    if (total > maximum) {
      a.destroy();
      b.destroy();
    }
  };
  a.on("data", account);
  b.on("data", account);
}

function applyIdleLimit(a: Socket, b: Socket, idleMs: number): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    a.destroy();
    b.destroy();
  };
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(close, idleMs);
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
  };
  a.on("data", arm);
  b.on("data", arm);
  a.once("close", clear);
  b.once("close", clear);
  arm();
}

/**
 * Per-integration blind TLS tunnel. Authentication, exact origin policy, and
 * the SSRF floor are checked before any upstream socket is opened. When an
 * upstream proxy is selected, every failure terminates the request with 502;
 * direct egress is never attempted as a fallback.
 */
export function createBrowserEgressGateway(
  options: BrowserEgressGatewayOptions,
): BrowserEgressGatewayHandle {
  if (Buffer.byteLength(options.authToken) < 32) {
    throw new Error("browser gateway auth token must contain at least 256 bits of entropy");
  }
  const host = options.host ?? "127.0.0.1";
  const targets = allowedTargets(options.allowedOrigins);
  const emit = options.onEvent ?? (() => {});
  const blocked = options.isBlockedHostFn ?? isBlockedHost;
  const maxTunnelBytes = options.maxTunnelBytes ?? 256 * 1024 * 1024;
  const maxConcurrentTunnels = options.maxConcurrentTunnels ?? 64;
  const idleTunnelMs = options.idleTunnelMs ?? 5 * 60_000;
  if (
    !Number.isInteger(maxConcurrentTunnels) ||
    maxConcurrentTunnels < 1 ||
    maxConcurrentTunnels > 1024 ||
    !Number.isFinite(idleTunnelMs) ||
    idleTunnelMs <= 0 ||
    idleTunnelMs > 60 * 60_000
  ) {
    throw new Error("browser gateway connection limits are invalid");
  }
  let upstreamProxy: UpstreamProxyConfig | undefined;
  if (options.upstreamProxyUrl) upstreamProxy = parseUpstreamProxyUrl(options.upstreamProxyUrl);
  const liveSockets = new Set<Socket>();
  let activeTunnels = 0;

  const server = createServer((_req, res) => {
    res.writeHead(405).end();
  });

  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    liveSockets.add(client);
    client.once("close", () => liveSockets.delete(client));
    const target = req.url ?? "";
    const parsed = parseConnectTarget(target);
    const eventTarget = parsed ? `${parsed.host.toLowerCase()}:${parsed.port}` : "<invalid>";
    const deny = (status: number, reason: string) => {
      emit({ kind: "gateway-denied", target: eventTarget, reason });
      const statusText =
        status === 407
          ? "Proxy Authentication Required"
          : status === 429
            ? "Too Many Requests"
            : "Forbidden";
      client.write(`HTTP/1.1 ${status} ${statusText}\r\n\r\n`);
      client.destroy();
    };

    if (!tokenMatches(req.headers["proxy-authorization"], options.authToken)) {
      deny(407, "authentication");
      return;
    }
    if (!parsed) {
      deny(403, "invalid-target");
      return;
    }
    const targetHost = parsed.host.toLowerCase();
    const canonicalTarget = `${targetHost}:${parsed.port}`;
    if (!targets.has(canonicalTarget)) {
      deny(403, "origin-policy");
      return;
    }
    if (blocked(targetHost)) {
      deny(403, "ssrf");
      return;
    }
    if (activeTunnels >= maxConcurrentTunnels) {
      deny(429, "connection-limit");
      return;
    }
    activeTunnels += 1;
    let tunnelReserved = true;
    client.once("close", () => {
      if (!tunnelReserved) return;
      tunnelReserved = false;
      activeTunnels = Math.max(0, activeTunnels - 1);
    });

    void (async () => {
      let remote: Socket;
      try {
        // Resolve and pin before BOTH direct and proxied CONNECT. Sending the
        // hostname to an upstream proxy would delegate DNS there and reopen a
        // DNS-rebinding/private-address gap the sidecar could no longer
        // inspect. TLS remains end-to-end: Chromium still sends the original
        // SNI through this blind tunnel.
        const check = await resolveAndCheckHost(targetHost, {
          resolve: options.resolveHostFn,
          isBlockedHostFn: blocked,
        });
        if (check.blocked) {
          deny(403, check.reason === "resolution-failed" ? "dns-resolution-failed" : "ssrf");
          return;
        }
        if (upstreamProxy) {
          remote = await connectViaUpstreamProxy(
            addressTarget(check.pinnedAddress, parsed.port),
            upstreamProxy,
          );
        } else {
          remote = await new Promise<Socket>((resolve, reject) => {
            const socket = netConnectWithTimeout(parsed.port, check.pinnedAddress, () =>
              resolve(socket),
            );
            socket.once("error", reject);
          });
        }
      } catch {
        emit({
          kind: upstreamProxy ? "gateway-proxy-failed" : "gateway-denied",
          target: canonicalTarget,
          reason: upstreamProxy ? "proxy-unavailable" : "connect-failed",
        });
        client.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        client.destroy();
        return;
      }
      if (client.destroyed) {
        remote.destroy();
        return;
      }
      liveSockets.add(remote);
      remote.once("close", () => liveSockets.delete(remote));
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) remote.write(head);
      applyByteLimit(client, remote, maxTunnelBytes);
      applyIdleLimit(client, remote, idleTunnelMs);
      emit({ kind: "gateway-allowed", target: canonicalTarget });
      relaySockets(client, remote);
    })();
  });

  const ready = new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = () => {
    const bound = server.address();
    return bound && typeof bound === "object"
      ? { host: bound.address, port: bound.port }
      : { host, port: 0 };
  };
  return {
    ready,
    address,
    proxyUrl: () => {
      const bound = address();
      return `http://${bound.host}:${bound.port}`;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of liveSockets) socket.destroy();
        liveSockets.clear();
        server.close(() => resolve());
      }),
  };
}
