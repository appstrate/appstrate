// SPDX-License-Identifier: Apache-2.0

/**
 * Per-integration PLAIN CONNECT egress listener (issue #543).
 *
 * A local-source runner sits on the per-run network (`internal: true` in
 * docker mode) with no direct egress. When the integration injects a
 * credential header it gets a TLS-terminating MITM listener
 * ({@link createIntegrationMitmListener}) which doubles as its egress route.
 * When it injects NOTHING (a `delivery.env` auth — the server authenticates
 * itself, e.g. a form/session login) it only needs a way OUT, not a proxy
 * that opens its TLS. This listener is that way out:
 *
 *   - terminates the `CONNECT host:port` preamble,
 *   - applies the SSRF floor and the egress allowlist at CONNECT (internal /
 *     cloud-metadata / unauthorized targets are refused before any tunnel opens),
 *   - vets the tunnel's first bytes: a TLS ClientHello whose SNI names a host
 *     the allowlist does not grant is refused (a CDN front routes on SNI, so an
 *     allowed CONNECT target must not carry another tenant's name),
 *   - blind-relays raw TCP both directions (NO TLS termination, NO per-SNI
 *     cert mint, NO header injection).
 *
 * It deliberately mirrors the MITM listener's {@link MitmListenerHandle}
 * surface (`ready` / `address` / `proxyUrl` / `close`) so `integrations-boot`
 * collects and tears down both listener kinds uniformly. CONNECT-only, exactly
 * like the MITM listener (which 405s plain HTTP) — env-delivery runners
 * previously routed through MITM, so HTTPS-only egress is unchanged behaviour.
 *
 * Egress is a hard allowlist (#1458): only the owning runner may connect
 * (`isPeerAllowed`), and a CONNECT target is tunnelled only when the
 * connection's rendered `authorized_uris` grant its `host:port`
 * (`egressPolicy`). Everything else is refused (403 at CONNECT, a reset once tunnelled).
 */

import { createServer as netCreateServer } from "node:net";
import type { Socket } from "node:net";

import {
  isBlockedHost,
  peerAddress,
  peerAdmitted,
  resolveAndCheckHost,
  PREAMBLE_TIMEOUT_MS,
  type AuthorityPolicy,
  type HostResolver,
  type PeerCheck,
} from "./helpers.ts";
import { parseConnectTarget, netConnectWithTimeout, relaySockets } from "./connect-tunnel.ts";
import { extractSni, type MitmListenerHandle } from "./integration-mitm-listener.ts";

/** TLS plaintext record cap (RFC 8446 §5.1). */
const MAX_TLS_RECORD = 16_384;

/**
 * Collect the tunnel's first bytes: the whole first record when the stream
 * opens as TLS (0x16), else the first chunk. Arms the preamble timeout.
 */
function collectTunnelHead(socket: Socket, timeoutMs: number): Promise<Buffer> {
  socket.setTimeout(timeoutMs, () => socket.destroy());
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onClose = () => reject(new Error("socket closed before tunnel bytes"));
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf[0] === 0x16) {
        if (buf.length < 5) return;
        const recordLen = buf.readUInt16BE(3);
        if (recordLen <= MAX_TLS_RECORD && buf.length < 5 + recordLen) return;
      }
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.pause(); // buffer until relaySockets' pipe() resumes
      resolve(buf);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
  });
}

/**
 * The SNI of a first TLS record: the host, null for a ClientHello carrying
 * none, undefined when the record is not a self-contained ClientHello (a
 * fragmented one could hide its SNI in a later record — fail closed).
 */
function clientHelloSni(head: Buffer): string | null | undefined {
  const recordLen = head.readUInt16BE(3);
  if (recordLen > MAX_TLS_RECORD || recordLen < 4 || head[5] !== 0x01) return undefined;
  if (4 + head.readUIntBE(6, 3) > recordLen) return undefined;
  return extractSni(head.subarray(0, 5 + recordLen));
}

export interface EgressListenerEvent {
  kind: "tunnel-opened" | "tunnel-refused" | "tunnel-error";
  /** `host:port` target of the CONNECT, or of the refused SNI (never a path / query). */
  target: string;
  /** Populated for `tunnel-refused` (SSRF / allowlist / SNI / peer) and `tunnel-error`. */
  reason?: string;
  /** Refused peer IP (`peer-not-allowed` only). */
  peer?: string;
}

interface CreateEgressListenerOptions {
  /** Bind host — adapter-chosen (0.0.0.0 bridged / 127.0.0.1 shared NS). */
  host?: string;
  /** Telemetry sink (host:port + outcome only — never request contents). */
  onEvent?: (event: EgressListenerEvent) => void;
  /** Injectable SSRF predicate (tests pass a permissive stub). */
  isBlockedHostFn?: typeof isBlockedHost;
  /**
   * Injectable DNS resolver for the rebind guard (tests stub it; production
   * uses the system resolver). Only consulted for non-IP-literal targets.
   */
  resolveHostFn?: HostResolver;
  /** The connection's egress allowlist: a CONNECT to a `host:port` it does not grant is refused. */
  egressPolicy: AuthorityPolicy;
  /** Only the owning runner may tunnel through this listener. */
  isPeerAllowed: PeerCheck;
  /** Deadline for the tunnel's first bytes after the 200 (tests shorten it). */
  preambleTimeoutMs?: number;
}

/**
 * Create a per-integration plain CONNECT egress listener on an ephemeral port.
 * Returns a {@link MitmListenerHandle}-shaped handle for uniform lifecycle
 * management alongside MITM listeners.
 */
export function createIntegrationEgressListener(
  options: CreateEgressListenerOptions,
): MitmListenerHandle {
  const host = options.host ?? "127.0.0.1";
  const isBlockedHostFn = options.isBlockedHostFn ?? isBlockedHost;
  const resolveHostFn = options.resolveHostFn;
  const emit = options.onEvent ?? (() => {});
  const { egressPolicy } = options;
  const preambleTimeoutMs = options.preambleTimeoutMs ?? PREAMBLE_TIMEOUT_MS;

  const server = netCreateServer();

  server.on("connection", (clientSocket: Socket) => {
    const refuse = (target: string, reason: string, peer?: string) => {
      emit({ kind: "tunnel-refused", target, reason, peer });
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
    };
    // Peer gate, started at accept: nothing a refused peer sends is acted upon.
    const admitted = peerAdmitted(clientSocket, options.isPeerAllowed);
    // The kernel hands us a raw TCP socket; we must read the CONNECT preamble
    // ourselves (net.Server has no `connect` event — that's http.Server). The
    // request line can be split across TCP segments, so accumulate until the
    // first CRLF instead of assuming it arrives in one chunk; cap the buffer so
    // a peer that never sends a CRLF can't grow it unbounded. Headers after the
    // request line are ignored (we tunnel, not inspect); a well-behaved CONNECT
    // client waits for the 200 before sending tunnel bytes, so none are lost.
    const MAX_PREAMBLE_BYTES = 8_192;
    let preamble = "";
    const onData = (chunk: Buffer) => {
      preamble += chunk.toString("latin1");
      const lineEnd = preamble.indexOf("\r\n");
      if (lineEnd === -1) {
        if (preamble.length > MAX_PREAMBLE_BYTES) {
          clientSocket.off("data", onData);
          clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
          clientSocket.destroy();
        }
        return; // request line not complete yet — await more segments
      }
      clientSocket.off("data", onData);
      void (async () => {
        if (!(await admitted)) {
          return refuse("<unknown>", "peer-not-allowed", peerAddress(clientSocket));
        }
        const firstLine = preamble.slice(0, lineEnd);
        const match = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/i.exec(firstLine);
        if (!match) {
          clientSocket.write("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
          clientSocket.destroy();
          return;
        }
        const target = match[1] ?? "";
        const parsed = parseConnectTarget(target);
        if (!parsed) {
          clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
          clientSocket.destroy();
          return;
        }
        const { host: targetHost, port } = parsed;
        const lowerHost = targetHost.toLowerCase();

        // SSRF floor, literal layer — refuse IP-literal / known-internal
        // targets before any DNS round-trip or tunnel.
        if (isBlockedHostFn(lowerHost)) return refuse(target, "ssrf");

        // Hard egress allowlist — before any DNS lookup of the name.
        if (!egressPolicy.allowsAuthority(lowerHost, port)) return refuse(target, "not-authorized");

        // SSRF floor, DNS-rebind layer (resolve-and-pin): a DNS name whose
        // A/AAAA record points inside (10.x, 169.254.169.254, …) passes the
        // literal check above — resolve every record, refuse if ANY lands in
        // a blocked range (fail closed on resolution failure), then connect
        // to the PINNED resolved IP so the upstream connect can't re-resolve
        // to a different answer. Pinning is safe here: this is a blind CONNECT
        // tunnel — the sidecar never opens TLS, the client's own handshake
        // carries SNI/Host for the original name.
        const check = await resolveAndCheckHost(lowerHost, {
          resolve: resolveHostFn,
          isBlockedHostFn,
        });
        if (clientSocket.destroyed) return; // client gave up during resolution
        if (check.blocked) {
          return refuse(
            target,
            check.reason === "resolution-failed" ? "dns-resolution-failed" : "ssrf",
          );
        }
        // The client sends its ClientHello only after the 200, so the upstream
        // is dialed first but receives nothing until the first bytes are vetted.
        const upstream = netConnectWithTimeout(port, check.pinnedAddress, () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          collectTunnelHead(clientSocket, preambleTimeoutMs)
            .then((head) => {
              const sni = head[0] === 0x16 ? clientHelloSni(head) : null;
              if (sni === undefined || (sni !== null && !egressPolicy.allowsAuthority(sni, port))) {
                const reason = sni === undefined ? "malformed-client-hello" : "not-authorized";
                emit({ kind: "tunnel-refused", target: sni ? `${sni}:${port}` : target, reason });
                clientSocket.destroy();
                return;
              }
              upstream.write(head); // replay the vetted bytes before splicing
              emit({ kind: "tunnel-opened", target });
              relaySockets(clientSocket, upstream);
            })
            .catch(() => clientSocket.destroy());
        });
        upstream.on("error", (err: Error) => {
          emit({ kind: "tunnel-error", target, reason: err.message });
          clientSocket.destroy();
        });
        clientSocket.on("error", () => upstream.destroy());
        clientSocket.once("close", () => upstream.destroy());
      })();
    };
    clientSocket.on("data", onData);
    clientSocket.on("error", () => clientSocket.destroy());
  });

  let readyResolve!: () => void;
  const ready = new Promise<void>((res) => {
    readyResolve = res;
  });
  // Ephemeral port (0 → kernel-assigned, read back via address() after ready).
  server.listen(0, host, () => readyResolve());

  const addr = () => {
    const a = server.address();
    return a && typeof a === "object" ? { host: a.address, port: a.port } : { host, port: 0 };
  };

  return {
    ready,
    address: addr,
    proxyUrl() {
      const a = addr();
      return `http://${a.host}:${a.port}`;
    },
    close() {
      return new Promise<void>((res) => server.close(() => res()));
    },
  };
}
