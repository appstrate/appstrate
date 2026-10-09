// SPDX-License-Identifier: Apache-2.0

/**
 * Shared HTTP CONNECT-tunnel primitives.
 *
 * Both the agent's shared {@link createForwardProxy} (port 8081) and the
 * per-connection plain egress listener ({@link createIntegrationEgressListener},
 * issue #543) terminate `CONNECT host:port` and relay absolute-form `http://`
 * requests. This module is the ONE implementation of the mechanical parts they
 * share; the SSRF policy and any upstream-proxy chaining stay in each caller.
 */

import { request as httpRequest } from "node:http";
import type { IncomingMessage, RequestOptions, ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";

import { API_CALL_TIMEOUT_MS, HOP_BY_HOP_HEADERS } from "@appstrate/afps-runtime/resolvers";

/** Idle window after which a relayed tunnel is torn down (no data flowing). */
const TUNNEL_IDLE_TIMEOUT_MS = 120_000; // 2 min
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
 * Tie `to` to `from`: a close ends `to` once flushed then destroys it; an error, or a close while
 * `to` is still dialing, destroys it at once.
 */
function closeWith(from: Socket, to: Socket): void {
  from.on("error", () => to.destroy());
  from.once("close", () => {
    if (to.connecting) to.destroy();
    else if (!to.destroyed) to.end(() => to.destroy());
  });
}

/** {@link closeWith} both ways: wire it when the second socket is dialed. */
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

/** Blind bidirectional relay with an idle timeout; teardown is {@link tieSockets}' job. */
export function relaySockets(s1: Socket, s2: Socket): void {
  s1.pipe(s2);
  s2.pipe(s1);
  destroyBothWhenIdle(s1, s2);
}

/** Message headers minus the hop-by-hop set and the names `Connection` lists (RFC 9110 §7.6.1). */
export function withoutHopByHop(
  raw: IncomingMessage["headers"],
): Record<string, string | string[] | undefined> {
  const listed = (raw.connection ?? "").split(",").map((h) => h.trim().toLowerCase());
  const hopByHop = new Set([...HOP_BY_HOP_HEADERS, ...listed.filter(Boolean)]);
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => !hopByHop.has(key.toLowerCase())),
  );
}

/** Relay `req` upstream and the answer back, minus hop-by-hop headers; failure or 101 → 502. */
export function forwardHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: RequestOptions,
  onError: (err: Error) => void,
  timeoutMs = API_CALL_TIMEOUT_MS,
): void {
  let failed = false;
  const fail = (err: Error) => {
    if (failed) return;
    failed = true;
    onError(err);
    if (res.headersSent) return void res.destroy();
    res.writeHead(502);
    res.end("Proxy error");
  };
  let proxyReq: ReturnType<typeof httpRequest>;
  try {
    // Throws on a header value Bun's server parser accepted but its client refuses (e.g. `\x7f`).
    proxyReq = httpRequest(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, withoutHopByHop(proxyRes.headers));
      proxyRes.pipe(res);
    });
  } catch (err) {
    req.resume();
    return fail(err instanceof Error ? err : new Error(String(err)));
  }
  proxyReq.setTimeout(timeoutMs, () => {
    const err = new Error(`Request timeout after ${timeoutMs}ms`);
    // Bun 1.3 emits no `error` for this destroy: answer here.
    fail(err);
    proxyReq.destroy(err);
  });
  // Unheard on Bun 1.4, a 101 leaves `res` unanswered and the client waiting for good (Bun 1.3
  // emits `error` instead).
  proxyReq.on("upgrade", (_upgradeRes, socket: Socket) => {
    socket.destroy();
    fail(new Error("upstream switched protocols"));
  });
  req.on("error", () => proxyReq.destroy());
  res.on("error", () => proxyReq.destroy());
  proxyReq.on("error", fail);
  req.pipe(proxyReq);
}
