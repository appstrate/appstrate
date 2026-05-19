// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.2d — HTTPS MITM listener bound to a single integration's
 * credential payload (proposal §4.1.4 + §4.1.6).
 *
 * Wire flow:
 *
 *   [MCP subproc] --HTTP CONNECT host:443--> [listener:127.0.0.1:port]
 *                                                  | reply 200
 *                                                  v
 *                                          peek TLS ClientHello
 *                                                  v
 *                                          parse SNI host
 *                                                  v
 *                                  mint leaf cert (per-SNI cache)
 *                                                  v
 *                                  spawn / reuse Bun.serve {tls: leaf}
 *                                          on a private 127.0.0.1 port
 *                                                  v
 *                                  relay raw TCP between inbound and
 *                                          the per-SNI Bun.serve
 *                                                  v
 *                                          Bun.serve.fetch(req) →
 *                                       {@link planMitmAction}
 *                                                  v
 *                                  strip headers + inject credential
 *                                                  v
 *                                         fetch upstream HTTPS
 *                                                  v
 *                                  (401 + retry401? → refresh, retry once)
 *                                                  v
 *                                          response back over TLS
 *
 * Why per-SNI Bun.serve instances:
 *   `tls.createServer({SNICallback})` is broken in Bun (the callback
 *   never fires and `secureConnection` never emits). Bun.serve with
 *   pre-baked TLS material works reliably. We parse the SNI out of the
 *   first TLS record manually, mint the matching leaf, lazily start a
 *   Bun.serve per distinct host, and relay raw bytes between the
 *   inbound CONNECT-tunneled socket and the matching SNI server. Each
 *   Bun.serve is cheap (~one TCP listener + cert context) and lives
 *   for the rest of the integration's run.
 *
 * Scope discipline (what 1.2d does NOT do):
 *   - No HTTP-non-CONNECT proxying. MCP servers use HTTPS_PROXY and
 *     emit CONNECT; non-CONNECT is rejected with 405 to surface
 *     misconfiguration early.
 *   - No WebSocket upgrade pass-through (MCP integrations talk JSON-RPC
 *     over HTTPS; WS would need its own design).
 *   - No keep-alive on the upstream request — `Connection: close` so
 *     each call flows through a fresh fetch.
 */

import { createServer as netCreateServer, connect as netConnect, type Socket } from "node:net";
import type {
  HttpDeliveryPlan,
  IntegrationCredentialsPayload,
  MitmRequestContext,
} from "@appstrate/connect/integrations";
import { planMitmAction, type CaBundle } from "@appstrate/connect/integrations";
import { HOP_BY_HOP_HEADERS, matchesAuthorizedUriSpec } from "@appstrate/connect/proxy-primitives";
import type { CertMinter } from "./integration-cert-minter.ts";

// ─────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────

export interface MitmCredentialSource {
  current(): IntegrationCredentialsPayload;
  deliveryPlans(): Readonly<Record<string, HttpDeliveryPlan>>;
  refreshOnUnauthorized?(authKey: string): Promise<boolean>;
}

/**
 * Niveau 2 Phase 4 — defence-in-depth URL envelope. When provided, every
 * upstream request must match at least one entry (pattern + optional
 * method set) before the MITM proxy injects credentials and forwards.
 * Patterns share the same glob grammar (`*` / `**`) as the per-auth
 * `authorizedUris`. Omitted on a pattern = any method matches.
 *
 * `undefined` (or an empty array) skips this check entirely — the
 * legacy per-auth `authorizedUris` still applies via the planner.
 */
export interface ToolUrlEnvelopeEntry {
  pattern: string;
  methods?: readonly string[];
}

export interface CreateMitmListenerOptions {
  caBundle: CaBundle;
  minter: CertMinter;
  credentials: MitmCredentialSource;
  /** Port to listen on. Defaults to 0 (ephemeral); read from `address()` after `ready`. */
  port?: number;
  /** Host to bind. Defaults to `"127.0.0.1"`. */
  host?: string;
  /** Max inner-request body size in bytes. Defaults to 10 MiB. */
  maxRequestBytes?: number;
  /** Upstream fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Telemetry sink — non-fatal events surface here. */
  onEvent?: (event: MitmListenerEvent) => void;
  /** See {@link ToolUrlEnvelopeEntry}. */
  toolUrlEnvelope?: readonly ToolUrlEnvelopeEntry[];
}

export type MitmListenerEvent =
  | { kind: "connect-accepted"; host: string; port: number }
  | { kind: "connect-rejected"; reason: string }
  | {
      kind: "request-forwarded";
      url: string;
      status: number;
      authKey: string | null;
      retried: boolean;
    }
  | { kind: "request-refused"; url: string; reason: string }
  | { kind: "tls-error"; error: string }
  | { kind: "upstream-error"; url: string; error: string };

export interface MitmListenerHandle {
  readonly ready: Promise<void>;
  address(): { host: string; port: number };
  proxyUrl(): string;
  close(): Promise<void>;
}

interface BunServerHandle {
  hostname: string;
  port: number;
  stop(): void;
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────

export function createIntegrationMitmListener(
  options: CreateMitmListenerOptions,
): MitmListenerHandle {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const maxRequestBytes = options.maxRequestBytes ?? 10 * 1024 * 1024;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const emit = options.onEvent ?? (() => {});
  const envelope =
    options.toolUrlEnvelope && options.toolUrlEnvelope.length > 0 ? options.toolUrlEnvelope : null;

  // Per-SNI cache of Bun.serve instances.
  const tlsServers = new Map<string, Promise<BunServerHandle>>();

  const getOrCreateTlsServer = (sniHost: string): Promise<BunServerHandle> => {
    const cached = tlsServers.get(sniHost);
    if (cached) return cached;
    const p = (async () => {
      const leaf = await options.minter.mintForHost(sniHost);
      const bun = (
        globalThis as unknown as {
          Bun?: {
            serve: (opts: {
              port: number;
              hostname: string;
              tls: { cert: string; key: string };
              fetch: (req: Request) => Promise<Response>;
            }) => BunServerHandle;
          };
        }
      ).Bun;
      if (!bun) {
        throw new Error("MITM listener requires the Bun runtime (Bun.serve)");
      }
      return bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        tls: { cert: leaf.certPem, key: leaf.keyPem },
        fetch: (req) =>
          handleInnerRequest(
            req,
            sniHost,
            options.credentials,
            fetchFn,
            maxRequestBytes,
            emit,
            envelope,
          ),
      });
    })();
    tlsServers.set(sniHost, p);
    return p;
  };

  // Outer TCP server: parse CONNECT, peek ClientHello for SNI, relay
  // to the per-SNI Bun.serve.
  const tcpServer = netCreateServer((rawSocket: Socket) => {
    handleInboundConnection(rawSocket, async (sniHost) => getOrCreateTlsServer(sniHost), emit);
  });

  let readyResolve!: () => void;
  const ready = new Promise<void>((res) => {
    readyResolve = res;
  });

  tcpServer.listen(port, host, () => {
    readyResolve();
  });

  return {
    ready,
    address() {
      const addr = tcpServer.address();
      if (addr && typeof addr === "object") {
        return { host: addr.address, port: addr.port };
      }
      return { host, port };
    },
    proxyUrl() {
      const addr = tcpServer.address();
      if (addr && typeof addr === "object") {
        return `http://${addr.address}:${addr.port}`;
      }
      return `http://${host}:${port}`;
    },
    async close() {
      await new Promise<void>((res) => {
        tcpServer.close(() => res());
      });
      for (const promise of tlsServers.values()) {
        try {
          const server = await promise;
          server.stop();
        } catch {
          // ignore — server never started
        }
      }
      tlsServers.clear();
    },
  };
}

// ─────────────────────────────────────────────
// Inbound connection handler
// ─────────────────────────────────────────────

async function handleInboundConnection(
  rawSocket: Socket,
  resolveTlsServer: (sniHost: string) => Promise<BunServerHandle>,
  emit: (event: MitmListenerEvent) => void,
): Promise<void> {
  rawSocket.on("error", () => {
    // Per-connection handlers own teardown.
  });

  // 1. Parse the CONNECT preamble.
  let preamble = Buffer.alloc(0);
  const MAX_PREAMBLE = 8 * 1024;
  const result = await new Promise<
    | { ok: true; host: string; port: number; remainder: Buffer }
    | { ok: false; reply: string; reason: string }
  >((resolve) => {
    const onData = (chunk: Buffer) => {
      preamble = Buffer.concat([preamble, chunk]);
      if (preamble.length > MAX_PREAMBLE) {
        rawSocket.off("data", onData);
        resolve({
          ok: false,
          reply: "HTTP/1.1 400 Bad Request\r\n\r\n",
          reason: "preamble too large",
        });
        return;
      }
      const end = preamble.indexOf("\r\n\r\n");
      if (end === -1) return;
      rawSocket.off("data", onData);
      const headers = preamble.subarray(0, end).toString("utf-8");
      const remainder = preamble.subarray(end + 4);
      const firstLine = headers.split("\r\n")[0] ?? "";
      const m = firstLine.match(/^CONNECT\s+(\S+)\s+HTTP\/1\.\d$/);
      if (!m) {
        resolve({
          ok: false,
          reply: "HTTP/1.1 405 Method Not Allowed\r\n\r\n",
          reason: `non-CONNECT request: '${firstLine.slice(0, 80)}'`,
        });
        return;
      }
      const parsed = parseHostPort(m[1] ?? "");
      if (!parsed) {
        resolve({
          ok: false,
          reply: "HTTP/1.1 400 Bad Request\r\n\r\n",
          reason: `invalid host:port '${m[1]}'`,
        });
        return;
      }
      resolve({ ok: true, host: parsed.host, port: parsed.port, remainder });
    };
    rawSocket.on("data", onData);
  });

  if (!result.ok) {
    rawSocket.write(result.reply);
    rawSocket.destroy();
    emit({ kind: "connect-rejected", reason: result.reason });
    return;
  }

  rawSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  emit({ kind: "connect-accepted", host: result.host, port: result.port });

  // 2. Peek the TLS ClientHello to extract SNI. We must NOT lose any
  //    bytes — every byte of the ClientHello goes downstream to the
  //    per-SNI server so the handshake completes there.
  let clientHello = result.remainder;
  if (clientHello.length === 0 || extractSni(clientHello) === null) {
    clientHello = await collectUntilSniParses(rawSocket, clientHello);
  }

  const sniHost = extractSni(clientHello);
  if (!sniHost) {
    emit({ kind: "tls-error", error: "could not extract SNI from ClientHello" });
    rawSocket.destroy();
    return;
  }

  // 3. Resolve (or lazily start) the per-SNI Bun.serve.
  let tlsServer: BunServerHandle;
  try {
    tlsServer = await resolveTlsServer(sniHost);
  } catch (err) {
    emit({ kind: "tls-error", error: `tls bring-up failed: ${(err as Error).message}` });
    rawSocket.destroy();
    return;
  }

  // 4. Relay raw bytes. We have to write the captured ClientHello to
  //    the upstream first, then pipe both directions.
  const upstream = netConnect(tlsServer.port, tlsServer.hostname, () => {
    if (clientHello.length > 0) upstream.write(clientHello);
    rawSocket.pipe(upstream);
    upstream.pipe(rawSocket);
  });
  upstream.on("error", (err) => {
    emit({ kind: "tls-error", error: `tls relay error: ${err.message}` });
    rawSocket.destroy();
  });
  rawSocket.on("close", () => upstream.destroy());
  upstream.on("close", () => rawSocket.destroy());
}

/**
 * Read more bytes from the raw socket until `extractSni` succeeds OR
 * the buffer exceeds 16 KiB (TLS record max payload, sentinel). The
 * accumulated buffer is returned and the data listener is detached
 * before we pipe to upstream.
 */
async function collectUntilSniParses(rawSocket: Socket, seed: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = seed;
    const MAX = 16 * 1024;
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX) {
        rawSocket.off("data", onData);
        resolve(buf); // give up — extract returns null, caller errors out
        return;
      }
      if (extractSni(buf) !== null) {
        rawSocket.off("data", onData);
        resolve(buf);
      }
    };
    rawSocket.on("data", onData);
    rawSocket.on("error", reject);
  });
}

// ─────────────────────────────────────────────
// TLS ClientHello SNI parser
// ─────────────────────────────────────────────

/**
 * Extract the SNI hostname from a TLS ClientHello record. Returns the
 * host string (lowercased) or `null` when the buffer doesn't yet
 * contain enough data or the message isn't a ClientHello.
 *
 * Structure (RFC 8446 §4.1.2 + RFC 6066 §3):
 *
 *   TLSPlaintext:
 *     uint8 ContentType (0x16 = handshake)
 *     uint16 ProtocolVersion
 *     uint16 length
 *     opaque fragment[length]
 *
 *   Handshake (within fragment):
 *     uint8 type (0x01 = ClientHello)
 *     uint24 length
 *     ClientHello body
 *
 *   ClientHello body:
 *     uint16 legacy_version
 *     32 bytes random
 *     uint8 session_id_len, opaque session_id
 *     uint16 cipher_suites_len, opaque cipher_suites
 *     uint8 compression_methods_len, opaque compression_methods
 *     uint16 extensions_len, opaque extensions
 *
 *   Extension:
 *     uint16 type (0x0000 = server_name)
 *     uint16 length
 *     opaque data
 *
 *   ServerNameList (extension data when type=0x0000):
 *     uint16 list_length
 *     ServerName{ uint8 name_type (0x00=host_name), uint16 host_len, opaque host_name }
 */
export function extractSni(buf: Buffer): string | null {
  let p = 0;
  // TLS record header
  if (buf.length < 5) return null;
  if (buf[0] !== 0x16) return null;
  const recordLen = buf.readUInt16BE(3);
  p = 5;
  if (buf.length < 5 + recordLen) return null;

  // Handshake header
  if (buf.length < p + 4) return null;
  if (buf[p] !== 0x01) return null; // ClientHello
  p += 4;

  // Body
  // legacy_version (2) + random (32)
  if (buf.length < p + 34) return null;
  p += 34;

  // session_id
  if (buf.length < p + 1) return null;
  const sidLen = buf[p]!;
  p += 1 + sidLen;

  // cipher_suites
  if (buf.length < p + 2) return null;
  const csLen = buf.readUInt16BE(p);
  p += 2 + csLen;

  // compression_methods
  if (buf.length < p + 1) return null;
  const cmLen = buf[p]!;
  p += 1 + cmLen;

  // extensions
  if (buf.length < p + 2) return null;
  const extTotal = buf.readUInt16BE(p);
  p += 2;
  const extEnd = p + extTotal;
  if (buf.length < extEnd) return null;

  while (p + 4 <= extEnd) {
    const extType = buf.readUInt16BE(p);
    const extLen = buf.readUInt16BE(p + 2);
    const extStart = p + 4;
    if (extStart + extLen > extEnd) return null;
    if (extType === 0x0000) {
      // server_name extension
      let q = extStart;
      if (q + 2 > extStart + extLen) return null;
      const listLen = buf.readUInt16BE(q);
      q += 2;
      const listEnd = q + listLen;
      if (listEnd > extStart + extLen) return null;
      while (q + 3 <= listEnd) {
        const nameType = buf[q]!;
        const hostLen = buf.readUInt16BE(q + 1);
        const hostStart = q + 3;
        if (hostStart + hostLen > listEnd) return null;
        if (nameType === 0x00) {
          return buf
            .subarray(hostStart, hostStart + hostLen)
            .toString("utf-8")
            .toLowerCase();
        }
        q = hostStart + hostLen;
      }
    }
    p = extStart + extLen;
  }
  return null;
}

// ─────────────────────────────────────────────
// Inner-request handler — Bun.serve fetch callback
// ─────────────────────────────────────────────

async function handleInnerRequest(
  req: Request,
  sniHost: string,
  credentials: MitmCredentialSource,
  fetchFn: typeof fetch,
  maxRequestBytes: number,
  emit: (event: MitmListenerEvent) => void,
  envelope: readonly ToolUrlEnvelopeEntry[] | null,
): Promise<Response> {
  // Re-build the upstream URL from the SNI host + request path. Bun
  // gives us the absolute URL but it points at our local 127.0.0.1
  // listener — we replace the origin with the SNI host (port 443).
  const incoming = new URL(req.url);
  const targetUrl = `https://${sniHost}${incoming.pathname}${incoming.search}`;

  // Phase 4 — envelope check happens BEFORE credential injection. A
  // request that won't be forwarded must never see the credential
  // header materialise, even briefly. Per-auth `authorizedUris` still
  // runs downstream via `planMitmAction`; envelope is the tighter
  // tool-derived restriction.
  if (envelope && !matchesEnvelope(envelope, targetUrl, req.method)) {
    emit({ kind: "request-refused", url: targetUrl, reason: "tool url envelope" });
    return new Response("MITM listener: URL outside tool envelope", { status: 403 });
  }

  let body: Buffer = Buffer.alloc(0);
  if (req.body) {
    try {
      const ab = await req.arrayBuffer();
      if (ab.byteLength > maxRequestBytes) {
        emit({ kind: "request-refused", url: targetUrl, reason: "body too large" });
        return new Response("MITM listener: request body exceeds limit", { status: 413 });
      }
      body = Buffer.from(ab);
    } catch (err) {
      emit({
        kind: "request-refused",
        url: targetUrl,
        reason: `body read: ${(err as Error).message}`,
      });
      return new Response("MITM listener: body read error", { status: 400 });
    }
  }

  const callerHeaderNames: string[] = [];
  req.headers.forEach((_v, k) => callerHeaderNames.push(k));

  const buildAction = () => {
    const ctx: MitmRequestContext = {
      url: targetUrl,
      headerNames: callerHeaderNames,
      deliveryPlans: credentials.deliveryPlans(),
    };
    return planMitmAction(ctx, credentials.current());
  };

  const action = buildAction();

  const outboundHeaders = buildOutboundHeaders(
    req.headers,
    sniHost,
    action.strippedHeaderNames,
    action.injectedHeader,
  );

  let response: Response;
  try {
    response = await fetchFn(targetUrl, {
      method: req.method,
      headers: outboundHeaders,
      ...(body.byteLength > 0 ? { body } : {}),
      redirect: "manual",
    });
  } catch (err) {
    emit({ kind: "upstream-error", url: targetUrl, error: (err as Error).message });
    return new Response(`MITM upstream error: ${(err as Error).message}`, { status: 502 });
  }

  if (
    response.status === 401 &&
    action.retry401 &&
    action.matchedAuth &&
    credentials.refreshOnUnauthorized
  ) {
    const refreshed = await credentials
      .refreshOnUnauthorized(action.matchedAuth.authKey)
      .catch(() => false);
    if (refreshed) {
      const action2 = buildAction();
      const outbound2 = buildOutboundHeaders(
        req.headers,
        sniHost,
        action2.strippedHeaderNames,
        action2.injectedHeader,
      );
      try {
        response = await fetchFn(targetUrl, {
          method: req.method,
          headers: outbound2,
          ...(body.byteLength > 0 ? { body } : {}),
          redirect: "manual",
        });
        emit({
          kind: "request-forwarded",
          url: targetUrl,
          status: response.status,
          authKey: action2.matchedAuth?.authKey ?? null,
          retried: true,
        });
        return passthroughResponse(response);
      } catch (err) {
        emit({ kind: "upstream-error", url: targetUrl, error: `retry: ${(err as Error).message}` });
      }
    }
  }

  emit({
    kind: "request-forwarded",
    url: targetUrl,
    status: response.status,
    authKey: action.matchedAuth?.authKey ?? null,
    retried: false,
  });
  return passthroughResponse(response);
}

function passthroughResponse(response: Response): Response {
  // Strip transfer-encoding / content-encoding which Bun's fetch
  // already handled and which would confuse the inner client.
  const headers = new Headers();
  response.headers.forEach((v, k) => {
    const lower = k.toLowerCase();
    if (lower === "transfer-encoding" || lower === "content-encoding" || lower === "content-length")
      return;
    headers.set(k, v);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ─────────────────────────────────────────────
// CONNECT preamble parsing
// ─────────────────────────────────────────────

/**
 * Phase 4 — check whether `url` (with the given `method`) matches any
 * envelope entry. Pattern grammar mirrors the AFPS 1.3 `authorizedUris`
 * matcher exposed by `@appstrate/connect/proxy-primitives` (`*` per
 * segment, `**` for arbitrary substrings). Methods are case-insensitive;
 * an entry with no `methods` field matches any verb.
 */
function matchesEnvelope(
  envelope: readonly ToolUrlEnvelopeEntry[],
  url: string,
  method: string,
): boolean {
  const upper = method.toUpperCase();
  for (const entry of envelope) {
    if (!matchesAuthorizedUriSpec(entry.pattern, url)) continue;
    if (!entry.methods || entry.methods.length === 0) return true;
    if (entry.methods.some((m) => m.toUpperCase() === upper)) return true;
  }
  return false;
}

function parseHostPort(target: string): { host: string; port: number } | null {
  if (!target) return null;
  if (target.startsWith("[")) {
    const closeBracket = target.indexOf("]");
    if (closeBracket === -1) return null;
    const host = target.slice(1, closeBracket);
    const rest = target.slice(closeBracket + 1);
    const port = rest.startsWith(":") ? Number.parseInt(rest.slice(1), 10) : 443;
    if (!Number.isFinite(port)) return null;
    return { host, port };
  }
  const colon = target.lastIndexOf(":");
  if (colon === -1) return { host: target, port: 443 };
  const host = target.slice(0, colon);
  const port = Number.parseInt(target.slice(colon + 1), 10);
  if (!host || !Number.isFinite(port)) return null;
  return { host, port };
}

// ─────────────────────────────────────────────
// Header plumbing
// ─────────────────────────────────────────────

function buildOutboundHeaders(
  incoming: Headers,
  sniHost: string,
  strip: readonly string[],
  inject: { name: string; value: string } | null,
): Headers {
  const stripLower = new Set(strip.map((s) => s.toLowerCase()));
  const out = new Headers();
  incoming.forEach((v, k) => {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    if (stripLower.has(lower)) return;
    if (lower === "host") return; // re-added below
    if (lower === "content-length") return; // fetch sets from body
    out.set(k, v);
  });
  out.set("Host", sniHost);
  if (inject) out.set(inject.name, inject.value);
  return out;
}
