// SPDX-License-Identifier: Apache-2.0

/**
 * Per-connection PLAIN CONNECT egress listener (issue #543).
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
 *   - applies the SSRF floor and the egress allowlist at CONNECT, then to the
 *     ClientHello's SNI (a CDN front routes on SNI, not on the CONNECT target),
 *   - blind-relays raw TCP both directions (NO TLS termination, NO per-SNI
 *     cert mint, NO header injection).
 *
 * It deliberately mirrors the MITM listener's {@link MitmListenerHandle}
 * surface (`ready` / `address` / `proxyUrl` / `close`) so `integrations-boot`
 * collects and tears down both listener kinds uniformly. It also relays ONE
 * absolute-form `http://` request per connection, vetted like CONNECT (#1819):
 * nothing is injected here, so cleartext carries no credential.
 *
 * Only the owning runner may connect (`isPeerAllowed`, #1458).
 */

import { createServer as netCreateServer } from "node:net";
import type { Socket } from "node:net";

import {
  isBlockedHost,
  peerAddress,
  peerAdmitted,
  resolveAndCheckHost,
  ssrfFloorFor,
  PREAMBLE_TIMEOUT_MS,
  type AuthorityPolicy,
  type HostResolver,
  type PeerCheck,
} from "./helpers.ts";
import {
  closeWith,
  destroyBothWhenIdle,
  hopByHopHeaders,
  parseConnectTarget,
  netConnectWithTimeout,
} from "./connect-tunnel.ts";
import { extractSni, type MitmListenerHandle } from "./integration-mitm-listener.ts";

/** TLS plaintext record cap (RFC 8446 §5.1). */
const MAX_TLS_RECORD = 16_384;

/** The tunnel's first bytes: the whole first record if TLS (0x16), else the first chunk. */
function collectTunnelHead(socket: Socket): Promise<Buffer> {
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
      socket.pause(); // buffer until pipe() resumes
      resolve(buf);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.resume(); // paused since the request head
  });
}

// SNI of the first record: null when absent, undefined when the record is not a
// self-contained ClientHello (a fragmented one could hide its SNI — fail closed).
function clientHelloSni(head: Buffer): string | null | undefined {
  const recordLen = head.readUInt16BE(3);
  if (recordLen > MAX_TLS_RECORD || recordLen < 4 || head[5] !== 0x01) return undefined;
  if (4 + head.readUIntBE(6, 3) > recordLen) return undefined;
  return extractSni(head.subarray(0, 5 + recordLen));
}

/** Kept even when `Connection` names them: the body is relayed byte for byte. */
const FRAMING_HEADERS = new Set(["content-length", "transfer-encoding"]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** The relayed head: URL authority as `Host` (RFC 9112 §3.2.2), no hop-by-hop, one request. */
function originFormHead(requestLine: string, host: string, lines: string[]): string | null {
  const fields: Array<{ name: string; value: string; line: string }> = [];
  for (const line of lines) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon);
    if (colon === -1 || !HEADER_NAME.test(name) || /[\r\n]/.test(line)) return null;
    fields.push({ name: name.toLowerCase(), value: line.slice(colon + 1), line });
  }
  const connection = fields.filter((f) => f.name === "connection").map((f) => f.value);
  const hopByHop = hopByHopHeaders(connection.join(","));
  const kept = fields
    .filter((f) => f.name !== "host" && (FRAMING_HEADERS.has(f.name) || !hopByHop.has(f.name)))
    .map((f) => f.line);
  return [requestLine, `Host: ${host}`, ...kept, "Connection: close", "", ""].join("\r\n");
}

export interface EgressListenerEvent {
  kind: "tunnel-opened" | "tunnel-refused" | "tunnel-error";
  /** `host:port` of the CONNECT / `http://` target or of the refused SNI (never a path / query). */
  target: string;
  /** Populated for `tunnel-refused` (SSRF / allowlist / SNI / peer / preamble timeout) and `tunnel-error`. */
  reason?: string;
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
  egressPolicy: AuthorityPolicy;
  isPeerAllowed: PeerCheck;
  /** Deadline for the client's first bytes while upstream is silent too (tests shorten it). */
  preambleTimeoutMs?: number;
}

/**
 * Create a per-connection plain CONNECT egress listener on an ephemeral port.
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
    const reply = (status: string) => {
      clientSocket.write(`HTTP/1.1 ${status}\r\n\r\n`);
      clientSocket.destroy();
    };
    const refuse = (target: string, reason: string, peer?: string) => {
      emit({ kind: "tunnel-refused", target, reason, peer });
      reply("403 Forbidden");
    };
    // Peer gate, started at accept: nothing a refused peer sends is acted upon.
    const admitted = peerAdmitted(clientSocket, options.isPeerAllowed);
    // Bounds the request head only; the dial has its own timeout, the relay its idle window.
    clientSocket.setTimeout(preambleTimeoutMs, () => clientSocket.destroy());

    // Floor and allowlist before any DNS lookup, then the rebind layer and a dial to the PINNED
    // IP (the client's handshake or `Host` header carries the name).
    const vetAndDial = async (
      target: string,
      host: string,
      port: number,
      onConnect: (upstream: Socket) => void,
    ) => {
      const lowerHost = host.toLowerCase();
      const ssrfFloor = ssrfFloorFor(egressPolicy, lowerHost, port, isBlockedHostFn);
      if (ssrfFloor(lowerHost)) return refuse(target, "ssrf");
      if (!egressPolicy.allowsAuthority(lowerHost, port)) return refuse(target, "not-authorized");
      const check = await resolveAndCheckHost(lowerHost, {
        resolve: resolveHostFn,
        isBlockedHostFn: ssrfFloor,
      });
      if (clientSocket.destroyed) return; // client gave up during resolution
      if (check.blocked) {
        return refuse(
          target,
          check.reason === "resolution-failed" ? "dns-resolution-failed" : "ssrf",
        );
      }
      const upstream = netConnectWithTimeout(port, check.pinnedAddress, () => {
        destroyBothWhenIdle(clientSocket, upstream);
        onConnect(upstream);
      });
      upstream.on("error", (err: Error) => {
        emit({ kind: "tunnel-error", target, reason: err.message });
      });
      closeWith(upstream, clientSocket);
      closeWith(clientSocket, upstream);
    };

    // Upstream receives nothing until the client's head is vetted; its own
    // bytes flow at once (server-first banners: SMTP, IMAP, MySQL…).
    const tunnel = (target: string, port: number) => (upstream: Socket) => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(clientSocket);
      // Only a tunnel silent on BOTH sides dies at the preamble deadline.
      const preamble = setTimeout(() => {
        emit({ kind: "tunnel-refused", target, reason: "preamble-timeout" });
        clientSocket.destroy();
      }, preambleTimeoutMs);
      const endPreamble = () => clearTimeout(preamble);
      upstream.once("data", endPreamble);
      clientSocket.once("close", endPreamble);
      collectTunnelHead(clientSocket)
        .then((head) => {
          endPreamble();
          const sni = head[0] === 0x16 ? clientHelloSni(head) : null;
          if (sni === undefined || (sni !== null && !egressPolicy.allowsAuthority(sni, port))) {
            const reason = sni === undefined ? "malformed-client-hello" : "not-authorized";
            emit({ kind: "tunnel-refused", target: sni ? `${sni}:${port}` : target, reason });
            clientSocket.destroy();
            return;
          }
          upstream.write(head); // replay the vetted bytes before splicing
          emit({ kind: "tunnel-opened", target });
          clientSocket.pipe(upstream);
        })
        .catch(() => clientSocket.destroy());
    };

    // net.Server has no `connect` event: read the head across segments, up to a cap. Later bytes
    // wait paused for the relay; an `http://` body read with the head is replayed after it.
    const MAX_PREAMBLE_BYTES = 8_192;
    let preamble = "";
    const onData = (chunk: Buffer) => {
      preamble += chunk.toString("latin1");
      const headEnd = preamble.indexOf("\r\n\r\n");
      if (headEnd === -1 && preamble.length <= MAX_PREAMBLE_BYTES) return;
      clientSocket.off("data", onData);
      clientSocket.setTimeout(0);
      if (headEnd === -1 || headEnd > MAX_PREAMBLE_BYTES) return reply("400 Bad Request");
      clientSocket.pause();
      void (async () => {
        if (!(await admitted)) {
          return refuse("<unknown>", "peer-not-allowed", peerAddress(clientSocket));
        }
        const [requestLine = "", ...headerLines] = preamble.slice(0, headEnd).split("\r\n");
        const [, method = "", target = "", version = ""] =
          /^(\S+)\s+(\S+)\s+(HTTP\/1\.[01])$/i.exec(requestLine) ?? [];
        if (/^CONNECT$/i.test(method)) {
          const parsed = parseConnectTarget(target);
          if (!parsed) return reply("400 Bad Request");
          return vetAndDial(target, parsed.host, parsed.port, tunnel(target, parsed.port));
        }
        if (!/^http:\/\//i.test(target)) return reply("405 Method Not Allowed");
        const url = URL.parse(target);
        if (!url?.hostname || url.username || url.password) return reply("400 Bad Request");
        const port = url.port ? Number(url.port) : 80;
        const originLine = `${method} ${url.pathname}${url.search} ${version.toUpperCase()}`;
        const head = originFormHead(originLine, url.host, headerLines);
        if (head === null) return reply("400 Bad Request");
        const body = preamble.slice(headEnd + 4);
        const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
        const authority = `${url.hostname}:${port}`;
        await vetAndDial(authority, host, port, (upstream) => {
          upstream.write(Buffer.from(head + body, "latin1"));
          emit({ kind: "tunnel-opened", target: authority });
          clientSocket.pipe(upstream);
          upstream.pipe(clientSocket);
        });
      })().catch((err: unknown) => {
        // One bad connection must never become an unhandled rejection: Bun would exit.
        const reason = err instanceof Error ? err.name : "unknown";
        emit({ kind: "tunnel-error", target: "<unknown>", reason });
        clientSocket.destroy();
      });
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
