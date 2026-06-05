// SPDX-License-Identifier: Apache-2.0

/**
 * Shared HTTP CONNECT-tunnel primitives.
 *
 * Both the agent's shared {@link createForwardProxy} (port 8081) and the
 * per-integration plain egress listener ({@link createIntegrationEgressListener},
 * issue #543) terminate the same `CONNECT host:port` preamble, apply the same
 * SSRF floor, and then blind-relay raw TCP both directions. This module holds
 * the mechanical parts they share so there is ONE implementation of target
 * parsing, connect-with-timeout, and bidirectional relay — the SSRF policy and
 * any upstream-proxy chaining stay in each caller (they differ).
 */

import { connect as netConnect } from "node:net";
import type { Socket } from "node:net";

/** Idle window after which a relayed tunnel is torn down (no data flowing). */
export const TUNNEL_IDLE_TIMEOUT_MS = 120_000; // 2 min
/** Max time to wait for the upstream TCP connection to establish. */
export const TUNNEL_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Parse a CONNECT target (`host:port`, IPv6 `[::1]:443`, or bare `host`).
 * Returns `null` on a malformed target (empty host / missing `]`). Port
 * defaults to 443 when absent or unparseable.
 */
export function parseConnectTarget(target: string): { host: string; port: number } | null {
  let host: string;
  let port: number;
  if (target.startsWith("[")) {
    const closeBracket = target.indexOf("]");
    if (closeBracket === -1) return null;
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
  if (!host) return null;
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
 * Blind bidirectional relay between two sockets, with an idle timeout and
 * mutual teardown on error/close. Used after a CONNECT tunnel is established.
 */
export function relaySockets(s1: Socket, s2: Socket, idleMs = TUNNEL_IDLE_TIMEOUT_MS): void {
  s1.pipe(s2);
  s2.pipe(s1);
  s1.setTimeout(idleMs, () => s1.destroy());
  s2.setTimeout(idleMs, () => s2.destroy());
  s1.on("error", () => s2.destroy());
  s2.on("error", () => s1.destroy());
  s1.on("close", () => {
    if (!s2.destroyed) s2.destroy();
  });
  s2.on("close", () => {
    if (!s1.destroyed) s1.destroy();
  });
}
