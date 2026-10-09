// SPDX-License-Identifier: Apache-2.0

/**
 * Shared HTTP CONNECT-tunnel primitives.
 *
 * Both the agent's shared {@link createForwardProxy} (port 8081) and the
 * per-connection plain egress listener ({@link createIntegrationEgressListener},
 * issue #543) terminate the same `CONNECT host:port` preamble, apply the same
 * SSRF floor, and then blind-relay raw TCP both directions. This module holds
 * the mechanical parts they share so there is ONE implementation of target
 * parsing, connect-with-timeout, relay and `http://` forwarding — the SSRF policy and
 * any upstream-proxy chaining stay in each caller (they differ).
 */

import { request as httpRequest } from "node:http";
import type { IncomingMessage, RequestOptions, ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";

import { API_CALL_TIMEOUT_MS, HOP_BY_HOP_HEADERS } from "@appstrate/afps-runtime/resolvers";

/** Idle window after which a relayed tunnel is torn down (no data flowing). */
export const TUNNEL_IDLE_TIMEOUT_MS = 120_000; // 2 min
/** Max time to wait for the upstream TCP connection to establish. */
const TUNNEL_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Parse a CONNECT target (`host:port`, IPv6 `[::1]:443`, or bare `host`).
 * Returns `null` on a malformed target: empty host, missing `]`, or a port
 * that is not 1–65535 in plain digits. Port defaults to 443 only when absent.
 */
export function parseConnectTarget(target: string): { host: string; port: number } | null {
  let host: string;
  let rawPort: string | undefined;
  if (target.startsWith("[")) {
    const closeBracket = target.indexOf("]");
    if (closeBracket === -1) return null;
    host = target.slice(1, closeBracket);
    const rest = target.slice(closeBracket + 1);
    if (rest && !rest.startsWith(":")) return null;
    rawPort = rest ? rest.slice(1) : undefined;
  } else {
    const colonIdx = target.lastIndexOf(":");
    host = colonIdx === -1 ? target : target.slice(0, colonIdx);
    rawPort = colonIdx === -1 ? undefined : target.slice(colonIdx + 1);
  }
  const port = rawPort === undefined ? 443 : /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : 0;
  if (!host || port < 1 || port > 65535) return null;
  return { host, port };
}

/**
 * `net.connect` with a connect-establishment timeout — destroys the socket
 * (surfacing an error) if the TCP handshake doesn't complete in time.
 */
export function netConnectWithTimeout(
  port: number,
  host: string,
  onConnect: () => void,
  timeoutMs = TUNNEL_CONNECT_TIMEOUT_MS,
): Socket {
  const socket = netConnect(port, host, () => {
    clearTimeout(timer);
    onConnect();
  });
  const timer = setTimeout(() => {
    socket.destroy(new Error(`Connect timeout after ${timeoutMs}ms to ${host}:${port}`));
  }, timeoutMs);
  socket.on("close", () => clearTimeout(timer));
  return socket;
}

/**
 * Tie `to` to `from`: a half-close is passed on (the reply still flows back), a close ends `to`
 * once flushed then destroys it, an error destroys it at once, as does any close while dialing.
 */
export function closeWith(from: Socket, to: Socket): void {
  from.on("error", () => to.destroy());
  from.once("end", () => {
    if (!to.destroyed) to.end();
  });
  from.once("close", () => {
    if (to.connecting) to.destroy();
    else if (!to.destroyed) to.end(() => to.destroy());
  });
}

/** {@link closeWith} both ways. */
export function tieSockets(s1: Socket, s2: Socket): void {
  closeWith(s1, s2);
  closeWith(s2, s1);
}

export function destroyBothWhenIdle(s1: Socket, s2: Socket, idleMs = TUNNEL_IDLE_TIMEOUT_MS): void {
  const destroyBoth = () => {
    s1.destroy();
    s2.destroy();
  };
  s1.setTimeout(idleMs, destroyBoth);
  s2.setTimeout(idleMs, destroyBoth);
}

/**
 * Blind bidirectional relay between two sockets, with an idle timeout and
 * mutual teardown on error/close. Used after a CONNECT tunnel is established.
 */
export function relaySockets(s1: Socket, s2: Socket, idleMs = TUNNEL_IDLE_TIMEOUT_MS): void {
  s1.pipe(s2);
  s2.pipe(s1);
  destroyBothWhenIdle(s1, s2, idleMs);
  tieSockets(s1, s2);
}

/** Request headers minus the hop-by-hop set and the names `Connection` lists. */
export function withoutHopByHop(
  raw: IncomingMessage["headers"],
): Record<string, string | string[] | undefined> {
  const listed = (raw.connection ?? "").split(",").map((h) => h.trim().toLowerCase());
  const hopByHop = new Set([...HOP_BY_HOP_HEADERS, ...listed.filter(Boolean)]);
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => !hopByHop.has(key.toLowerCase())),
  );
}

/** Stream `req` upstream as `options` says and the answer back on `res`; a failure answers 502. */
export function forwardHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: RequestOptions,
  onError: (err: Error) => void,
): void {
  const proxyReq = httpRequest(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.setTimeout(API_CALL_TIMEOUT_MS, () => {
    proxyReq.destroy(new Error(`Request timeout after ${API_CALL_TIMEOUT_MS}ms`));
  });
  req.on("error", () => proxyReq.destroy());
  res.on("error", () => proxyReq.destroy());
  proxyReq.on("error", (err) => {
    onError(err);
    if (!res.headersSent) res.writeHead(502);
    res.end("Proxy error");
  });
  req.pipe(proxyReq);
}
