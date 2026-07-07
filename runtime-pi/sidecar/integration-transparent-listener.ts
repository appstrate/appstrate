// SPDX-License-Identifier: Apache-2.0

/**
 * Transparent (proxy-unaware) egress listener for `delivery.env`
 * integrations (issue #779).
 *
 * The plain CONNECT egress listener assumes a cooperative HTTP client
 * that honours `HTTPS_PROXY` and speaks CONNECT. Surveying popular
 * third-party MCP servers shows the opposite is the norm: undici/`fetch`
 * ignores proxy env vars entirely, axios sends non-CONNECT forward-proxy
 * requests for HTTPS (→ 405). Both die behind the CONNECT-only egress
 * with an opaque timeout.
 *
 * This listener removes the cooperation requirement. The per-run DNS
 * responder ({@link createIntegrationDnsResponder}) resolves every
 * external hostname to the sidecar's IP, so the runner's direct
 * `connect(host, 443)` lands here. We then:
 *
 *   - sniff the first byte — 0x16 → TLS ClientHello, else plain HTTP;
 *   - TLS: accumulate until the SNI parses ({@link extractSni}), take the
 *     hostname from it. NO TLS termination — privacy model identical to
 *     the CONNECT tunnel (the sidecar never sees plaintext);
 *   - HTTP: read the request head, take the hostname from the `Host`
 *     header (the only place it exists — the wire target IP is ours);
 *   - apply the exact same SSRF floor as the CONNECT listener (literal
 *     layer + resolve-and-pin DNS-rebind layer, fail closed) and the same
 *     optional authorized-host matcher;
 *   - dial the upstream at the PINNED resolved address — never at the
 *     kernel-level original destination, which is always our own IP and,
 *     more importantly, is attacker-controlled ordering: the hostname the
 *     client *authenticated* (SNI / Host) is the only name the floor can
 *     meaningfully vet;
 *   - blind-splice both directions, replaying the buffered preamble bytes
 *     to the upstream first.
 *
 * A client that pins certificates still works (we never touch the TLS
 * stream). A client without SNI (rare, legacy) cannot be routed — the
 * socket is destroyed, which surfaces as a connection reset instead of a
 * silent hang. ECH (encrypted ClientHello) would also hide the SNI; no
 * mainstream HTTP library sends ECH without explicit configuration today.
 *
 * The upstream port is the listener's own nominal port (DNS spoofing
 * preserves the client's `host:port` intent — only the IP is rewritten),
 * overridable for tests that bind ephemeral ports.
 */

import { createServer as netCreateServer } from "node:net";
import type { Socket } from "node:net";

import { isBlockedHost, resolveAndCheckHost, type HostResolver } from "./helpers.ts";
import { netConnectWithTimeout, relaySockets } from "./connect-tunnel.ts";
import { extractSni, collectUntilSniParses } from "./integration-mitm-listener.ts";
import type { EgressListenerEvent } from "./integration-egress-listener.ts";

export interface CreateTransparentListenerOptions {
  /** Bind host — 0.0.0.0 on the per-run bridge network. */
  host?: string;
  /** Bind port — 443/80 in production; tests pass 0 for ephemeral. */
  port: number;
  /**
   * Port to dial upstream. Defaults to the listener's bound port (the
   * client's original intent — DNS spoofing only rewrites the IP).
   * Tests binding port 0 pass their fake upstream's port here.
   */
  upstreamPort?: number;
  /** Telemetry sink (host:port + outcome only — never payload bytes). */
  onEvent?: (event: EgressListenerEvent) => void;
  /** Injectable SSRF predicate (tests pass a permissive stub). */
  isBlockedHostFn?: typeof isBlockedHost;
  /** Injectable DNS resolver for the rebind guard (tests stub it). */
  resolveHostFn?: HostResolver;
  /**
   * Optional hard egress allowlist — same contract as the CONNECT
   * listener's `authorizedHostMatcher` (#543): `undefined` leaves egress
   * SSRF-floored-open, matching today's behaviour.
   */
  authorizedHostMatcher?: (host: string) => boolean;
}

export interface TransparentListenerHandle {
  ready: Promise<void>;
  address(): { host: string; port: number };
  close(): Promise<void>;
}

/** Cap on plain-HTTP head accumulation while hunting for the Host header. */
const MAX_HTTP_HEAD_BYTES = 16 * 1024;

/**
 * Read timeout for the preamble phase (ClientHello / HTTP head). A client
 * that connects and stalls — or sends a complete SNI-less ClientHello we
 * can never route — is torn down instead of holding the socket open.
 * Once the splice starts, {@link relaySockets} replaces this with its own
 * idle timeout.
 */
const PREAMBLE_TIMEOUT_MS = 10_000;

/**
 * Pull the hostname out of a plain-HTTP request head. Accepts both the
 * origin-form (`GET /x HTTP/1.1` + `Host: api.example.com`) every direct
 * client sends and — as a byproduct — the absolute-form some broken
 * forward-proxy clients emit. Strips any `:port` suffix (the port is the
 * listener's own). Returns null until the head terminator arrives.
 */
function extractHttpHost(head: string): string | null {
  const headerEnd = head.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;
  for (const line of head.slice(0, headerEnd).split("\r\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== "host") continue;
    const value = line
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    if (!value) return null;
    // IPv6 literal `[::1]:80` — keep brackets, strip port after `]`.
    if (value.startsWith("[")) {
      const close = value.indexOf("]");
      return close === -1 ? null : value.slice(1, close);
    }
    const portIdx = value.lastIndexOf(":");
    return portIdx === -1 ? value : value.slice(0, portIdx);
  }
  return null;
}

/** Accumulate socket data until the HTTP head terminator (or the cap). */
async function collectHttpHead(socket: Socket, seed: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = seed;
    if (buf.includes("\r\n\r\n")) {
      resolve(buf);
      return;
    }
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.includes("\r\n\r\n") || buf.length > MAX_HTTP_HEAD_BYTES) {
        socket.off("data", onData);
        resolve(buf);
      }
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.once("close", () => reject(new Error("socket closed before HTTP head")));
  });
}

/**
 * Create the transparent listener. One instance per exposed port (443 for
 * TLS, 80 for plain HTTP) — the first-byte sniff means either instance
 * routes both protocols correctly, the split is purely which ports we bind.
 */
export function createTransparentEgressListener(
  options: CreateTransparentListenerOptions,
): TransparentListenerHandle {
  const host = options.host ?? "0.0.0.0";
  const isBlockedHostFn = options.isBlockedHostFn ?? isBlockedHost;
  const resolveHostFn = options.resolveHostFn;
  const emit = options.onEvent ?? (() => {});
  const matcher = options.authorizedHostMatcher;

  const server = netCreateServer();

  server.on("connection", (clientSocket: Socket) => {
    // Upstream is dialed later, after the async SSRF/resolve phase. Track
    // it in the connection scope so ANY client teardown — including the
    // preamble idle-timeout firing mid-dial, before relaySockets wires its
    // own close handlers — reaps a half-open upstream instead of leaking it
    // until its own connect timeout. Idempotent: destroy() on a torn-down
    // socket is a no-op.
    let upstream: Socket | undefined;
    clientSocket.on("error", () => clientSocket.destroy());
    clientSocket.once("close", () => {
      if (upstream && !upstream.destroyed) upstream.destroy();
    });
    // Preamble deadline: hard cap on the pre-splice phase (ClientHello
    // collection + SSRF resolve + upstream dial) so a client that stalls —
    // or a hung DNS resolve — can't pin the socket forever. Once the splice
    // starts, relaySockets re-arms setTimeout on both sockets with its own
    // idle window, superseding this.
    clientSocket.setTimeout(PREAMBLE_TIMEOUT_MS, () => clientSocket.destroy());

    clientSocket.once("data", (first: Buffer) => {
      void (async () => {
        const isTls = first[0] === 0x16;
        const upstreamPort = options.upstreamPort ?? addr().port;

        // Collect enough of the preamble to learn the intended hostname.
        let preamble: Buffer;
        let targetHost: string | null;
        if (isTls) {
          preamble =
            extractSni(first) !== null ? first : await collectUntilSniParses(clientSocket, first);
          targetHost = extractSni(preamble);
        } else {
          preamble = await collectHttpHead(clientSocket, first);
          targetHost = extractHttpHost(preamble.toString("latin1"));
        }
        // The socket entered flowing mode when the preamble collectors
        // attached data listeners; from here to the splice there is an
        // async window (SSRF resolve + upstream dial) with NO listener —
        // pause so post-preamble bytes (an HTTP POST body, TLS early
        // data) buffer in the kernel instead of being emitted into the
        // void. relaySockets' pipe() resumes the stream.
        clientSocket.pause();

        if (!targetHost) {
          emit({
            kind: "tunnel-refused",
            target: `<unknown>:${upstreamPort}`,
            reason: isTls ? "no-sni" : "no-host-header",
          });
          clientSocket.destroy();
          return;
        }
        const target = `${targetHost}:${upstreamPort}`;

        // SSRF floor, literal layer — identical to the CONNECT path.
        if (isBlockedHostFn(targetHost)) {
          emit({ kind: "tunnel-refused", target, reason: "ssrf" });
          clientSocket.destroy();
          return;
        }

        // Optional hard egress allowlist (#543 contract; no-op by default).
        if (matcher && !matcher(targetHost)) {
          emit({ kind: "tunnel-refused", target, reason: "not-authorized" });
          clientSocket.destroy();
          return;
        }

        // SSRF floor, DNS-rebind layer (resolve-and-pin) — identical to the
        // CONNECT path. Pinning is safe: this is a blind splice, the client's
        // own TLS handshake carries the original SNI to the real upstream.
        const check = await resolveAndCheckHost(targetHost, {
          resolve: resolveHostFn,
          isBlockedHostFn,
        });
        if (clientSocket.destroyed) return; // client gave up during resolution
        if (check.blocked) {
          emit({
            kind: "tunnel-refused",
            target,
            reason: check.reason === "resolution-failed" ? "dns-resolution-failed" : "ssrf",
          });
          clientSocket.destroy();
          return;
        }

        // If the client already gave up (preamble timeout / RST) during the
        // async resolve, don't open a doomed upstream.
        if (clientSocket.destroyed) return;
        upstream = netConnectWithTimeout(upstreamPort, check.pinnedAddress, () => {
          // Replay the sniffed preamble first — the upstream must see the
          // byte stream exactly as the client produced it.
          upstream!.write(preamble);
          emit({ kind: "tunnel-opened", target });
          relaySockets(clientSocket, upstream!);
        });
        upstream.on("error", (err: Error) => {
          emit({ kind: "tunnel-error", target, reason: err.message });
          clientSocket.destroy();
        });
      })().catch(() => {
        clientSocket.destroy();
      });
    });
  });

  let readyResolve!: () => void;
  let readyReject!: (err: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  server.once("error", (err) => readyReject(err));
  server.listen(options.port, host, () => {
    server.removeAllListeners("error");
    server.on("error", () => {});
    readyResolve();
  });

  const addr = () => {
    const a = server.address();
    return a && typeof a === "object"
      ? { host: a.address, port: a.port }
      : { host, port: options.port };
  };

  return {
    ready,
    address: addr,
    close() {
      return new Promise<void>((res) => server.close(() => res()));
    },
  };
}
