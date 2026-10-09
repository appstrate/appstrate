// SPDX-License-Identifier: Apache-2.0

/**
 * Per-connection plain HTTP egress proxy (issue #543).
 *
 * A local-source runner sits on the per-run network (`internal: true` in
 * docker mode) with no direct egress. When the integration injects a
 * credential header it gets a TLS-terminating MITM listener
 * ({@link createIntegrationMitmListener}) which doubles as its egress route.
 * When it injects NOTHING (a `delivery.env` auth — the server authenticates
 * itself, e.g. a form/session login) it only needs a way OUT, not a proxy
 * that opens its TLS. This listener is that way out:
 *
 *   - `CONNECT host:port`: the SSRF floor and the egress allowlist apply at
 *     CONNECT, then to the ClientHello's SNI (a CDN front routes on SNI, not on
 *     the CONNECT target), then raw TCP is blind-relayed both directions (NO TLS
 *     termination, NO per-SNI cert mint, NO header injection);
 *   - absolute-form `http://` requests, vetted the same way and forwarded
 *     verbatim on a connection of their own (no injected credential).
 *
 * It deliberately mirrors the MITM listener's {@link MitmListenerHandle}
 * surface (`ready` / `address` / `proxyUrl` / `close`) so `integrations-boot`
 * collects and tears down both listener kinds uniformly.
 *
 * Only the owning runner may connect (`isPeerAllowed`, #1458).
 */

import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
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
  destroyBothWhenIdle,
  forwardHttpRequest,
  netConnectWithTimeout,
  parseConnectTarget,
  tieSockets,
  withoutHopByHop,
} from "./connect-tunnel.ts";
import { extractSni, type MitmListenerHandle } from "./integration-mitm-listener.ts";

/** TLS plaintext record cap (RFC 8446 §5.1). */
const MAX_TLS_RECORD = 16_384;

/** Whether `buf` holds the tunnel's whole first bytes: the first record if TLS (0x16), else any. */
function headComplete(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  if (buf[0] !== 0x16) return true;
  if (buf.length < 5) return false;
  const recordLen = buf.readUInt16BE(3);
  return recordLen > MAX_TLS_RECORD || buf.length >= 5 + recordLen;
}

/** The tunnel's first bytes, `seed` (read with the CONNECT head) first; the socket is left paused. */
function collectTunnelHead(socket: Socket, seed: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = seed;
    if (headComplete(buf)) return resolve(buf);
    const onClose = () => reject(new Error("socket ended before tunnel bytes"));
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!headComplete(buf)) return;
      socket.off("data", onData);
      socket.off("end", onClose);
      socket.off("close", onClose);
      socket.pause(); // buffer until pipe() resumes
      resolve(buf);
    };
    socket.on("data", onData);
    socket.once("end", onClose);
    socket.once("close", onClose);
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

interface HttpTarget {
  host: string;
  port: number;
  authority: string;
  hostHeader: string;
  path: string;
}

/** `undefined` for a non-`http://` target, `null` for a malformed or userinfo one. */
function httpTarget(raw: string): HttpTarget | null | undefined {
  if (!/^http:\/\//i.test(raw)) return undefined;
  const url = URL.parse(raw);
  if (!url?.hostname || url.username || url.password) return null;
  const port = url.port ? Number(url.port) : 80;
  if (port < 1) return null;
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port,
    authority: `${url.hostname}:${port}`,
    hostHeader: url.host,
    path: url.pathname + url.search,
  };
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
  /** Deadline for a tunnel's first bytes after the 200, while both sides are silent. */
  preambleTimeoutMs?: number;
  /** Idle deadline of a relayed `http://` request's upstream (default `API_CALL_TIMEOUT_MS`). */
  upstreamTimeoutMs?: number;
}

/**
 * Create a per-connection plain egress listener on an ephemeral port.
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

  // Peer gate, settled once per connection at accept: nothing a refused peer sends is acted upon.
  // A promise, as attribution is asynchronous; a socket never seen at accept is refused.
  const admissions = new WeakMap<Socket, Promise<boolean>>();
  const admitted = (socket: Socket) => admissions.get(socket) ?? Promise.resolve(false);
  // Requests pipelined on a connection are settled in order: once one is refused (its answer
  // closes the connection), the later ones are dropped unvetted. `false` = the connection closes.
  const turns = new WeakMap<Socket, Promise<boolean>>();

  // Floor and allowlist before any DNS lookup, then the rebind layer: the PINNED address, or why.
  const vet = async (
    targetHost: string,
    port: number,
  ): Promise<{ address: string } | { refused: string }> => {
    const lowerHost = targetHost.toLowerCase();
    const ssrfFloor = ssrfFloorFor(egressPolicy, lowerHost, port, isBlockedHostFn);
    if (ssrfFloor(lowerHost)) return { refused: "ssrf" };
    if (!egressPolicy.allowsAuthority(lowerHost, port)) return { refused: "not-authorized" };
    const check = await resolveAndCheckHost(lowerHost, {
      resolve: resolveHostFn,
      isBlockedHostFn: ssrfFloor,
    });
    if (!check.blocked) return { address: check.pinnedAddress };
    return { refused: check.reason === "resolution-failed" ? "dns-resolution-failed" : "ssrf" };
  };

  const refused = (target: string, reason: string, peer?: string) =>
    emit({ kind: "tunnel-refused", target, reason, peer });
  // One bad connection must never become an unhandled rejection: Bun would exit.
  const crashed = (destroy: () => void) => (err: unknown) => {
    const reason = err instanceof Error ? err.name : "unknown";
    emit({ kind: "tunnel-error", target: "<unknown>", reason });
    destroy();
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const reply = (status: number) => {
      req.resume();
      res.writeHead(status, { connection: "close", "content-length": "0" });
      res.end();
      return false;
    };
    if (!(await admitted(req.socket))) {
      refused("<unknown>", "peer-not-allowed", peerAddress(req.socket));
      return reply(403);
    }
    const target = httpTarget(req.url ?? "");
    if (target === undefined) return reply(405);
    if (target === null) return reply(400);
    const vetted = await vet(target.host, target.port);
    if (req.socket.destroyed) return false; // client gave up during resolution
    if ("refused" in vetted) {
      refused(target.authority, vetted.refused);
      return reply(403);
    }
    emit({ kind: "tunnel-opened", target: target.authority });
    const headers = { ...withoutHopByHop(req.headers), host: target.hostHeader };
    // `agent: false`: no upstream connection is pooled, so none is shared with another runner.
    const upstream = {
      hostname: vetted.address,
      port: target.port,
      path: target.path,
      agent: false,
    };
    forwardHttpRequest(
      req,
      res,
      { ...upstream, method: req.method, headers },
      (err) => emit({ kind: "tunnel-error", target: target.authority, reason: err.message }),
      options.upstreamTimeoutMs,
    );
    return true;
  };

  const handleConnect = async (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const reply = (status: string) => {
      clientSocket.write(`HTTP/1.1 ${status}\r\n\r\n`);
      clientSocket.destroy();
    };
    if (!(await admitted(clientSocket))) {
      refused("<unknown>", "peer-not-allowed", peerAddress(clientSocket));
      return reply("403 Forbidden");
    }
    const target = req.url ?? "";
    const parsed = parseConnectTarget(target);
    if (!parsed) return reply("400 Bad Request");
    const { port } = parsed;
    const vetted = await vet(parsed.host, port);
    if (clientSocket.destroyed) return; // client gave up during resolution
    if ("refused" in vetted) {
      refused(target, vetted.refused);
      return reply("403 Forbidden");
    }

    const upstream = netConnectWithTimeout(port, vetted.address, () => {
      destroyBothWhenIdle(clientSocket, upstream);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      // Upstream gets nothing until the client's first bytes are vetted; its bytes flow at once
      // (SMTP, IMAP banners…). Only a tunnel silent on BOTH sides dies at the deadline.
      upstream.pipe(clientSocket);
      const preamble = setTimeout(() => {
        refused(target, "preamble-timeout");
        clientSocket.destroy();
      }, preambleTimeoutMs);
      const endPreamble = () => clearTimeout(preamble);
      upstream.once("data", endPreamble);
      clientSocket.once("close", endPreamble);
      collectTunnelHead(clientSocket, head)
        .then((first) => {
          endPreamble();
          const sni = first[0] === 0x16 ? clientHelloSni(first) : null;
          if (sni === undefined || (sni !== null && !egressPolicy.allowsAuthority(sni, port))) {
            const reason = sni === undefined ? "malformed-client-hello" : "not-authorized";
            refused(sni ? `${sni}:${port}` : target, reason);
            clientSocket.destroy();
            return;
          }
          upstream.write(first); // replay the vetted bytes before splicing
          emit({ kind: "tunnel-opened", target });
          clientSocket.pipe(upstream);
        })
        .catch(() => clientSocket.destroy());
    });
    upstream.on("error", (err: Error) => {
      emit({ kind: "tunnel-error", target, reason: err.message });
    });
    tieSockets(clientSocket, upstream);
  };

  const server = createHttpServer();
  server.on("connection", (socket: Socket) => {
    admissions.set(socket, peerAdmitted(socket, options.isPeerAllowed));
  });
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const turn = (turns.get(req.socket) ?? Promise.resolve(true))
      .then((open) => (open ? handleRequest(req, res) : (req.resume(), false)))
      .catch((err: unknown) => (crashed(() => res.destroy())(err), false));
    turns.set(req.socket, turn);
  });
  server.on("connect", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    clientSocket.on("error", () => clientSocket.destroy());
    handleConnect(req, clientSocket, head).catch(crashed(() => clientSocket.destroy()));
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
