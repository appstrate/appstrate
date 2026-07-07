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
 *                       (401 on an injected auth → /refresh; retry once if rotated)
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
import {
  isBlockedHost,
  isBlockedUrl,
  resolveAndCheckHost,
  OUTBOUND_TIMEOUT_MS,
  type HostResolver,
} from "./helpers.ts";
import type {
  HttpDeliveryPlan,
  IntegrationCredentialsPayload,
} from "@appstrate/connect/integration-credentials";
import {
  planMitmAction,
  type MitmRequestContext,
} from "@appstrate/connect/integration-mitm-planner";
import type { CaBundle } from "@appstrate/connect/proxy-ca-planner";
import {
  HOP_BY_HOP_HEADERS,
  substituteVars,
  findUnresolvedPlaceholders,
  matchesAuthorizedUriSpec,
} from "@appstrate/connect/proxy-primitives";
import type { CertMinter } from "./integration-cert-minter.ts";

// ─────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────

/**
 * The active connect-login transient-input window, as surfaced by
 * {@link MitmCredentialSource.activeInputs}. Carries BOTH the `{{key}}`
 * substitution bag AND the acquiring auth's `authorizedUris` envelope so the
 * listener can bind the substitution to authorized targets only — the
 * transient login secret must NEVER be substituted into a request bound for an
 * off-allowlist host (exfiltration to an arbitrary origin the login tool
 * chose).
 */
export interface ActiveConnectInputs {
  /** Transient `{{key}}` → value substitutions (the raw login secret). */
  inputs: Record<string, string>;
  /**
   * Authorized-URI specs the acquiring auth declared. Substitution fires ONLY
   * for a target matching one of these (via {@link matchesAuthorizedUriSpec}).
   */
  authorizedUris: readonly string[];
}

export interface MitmCredentialSource {
  current(): IntegrationCredentialsPayload;
  deliveryPlans(): Readonly<Record<string, HttpDeliveryPlan>>;
  /**
   * Force a refresh after an upstream 401 (or a connect.tool re-login). Returns
   * true when the credential was rotated / re-minted (the listener retries the
   * request once). The platform `/refresh` it calls flags the connection
   * needsReconnection on a terminal failure, so a false result just means
   * "don't retry" — the dead-credential bookkeeping is platform-side.
   */
  refreshOnUnauthorized?(authKey: string): Promise<boolean>;
  /**
   * connect.tool mid-run re-login (P3) — when this returns true for
   * `(authKey, status)`, the listener treats `status` as a re-acquire trigger:
   * it calls {@link refreshOnUnauthorized} (which routes to the registered
   * re-login handler), rebuilds the action with the fresh session, and retries
   * the request once — even when the response wasn't a 401.
   */
  shouldReauth?(authKey: string, status: number): boolean;
  /**
   * True when a connect.tool re-login handler is registered for `authKey` (any
   * trigger status). Lets the listener leave a 401 that the manifest's
   * `reauth_on` deliberately EXCLUDES untouched, rather than mistaking the
   * session auth for a dead static credential and replaying / flagging it.
   * Optional — sources without it behave as a plain static credential.
   */
  hasReloginHandler?(authKey: string): boolean;
  /**
   * Connect-login primitive (P1) — when this returns a non-null bag, the
   * listener substitutes `{{key}}` placeholders into the outbound URL,
   * body, and inbound header values BEFORE building the credential action
   * (so the integration's login tool delivers the user's transient login
   * secret proxy-side, never as tool input). Optional — sources that don't
   * implement it behave exactly as before.
   *
   * The returned window carries the acquiring auth's `authorizedUris` so the
   * listener binds substitution to authorized targets only (see
   * {@link ActiveConnectInputs}).
   */
  activeInputs?(): ActiveConnectInputs | null;
}

export interface CreateMitmListenerOptions {
  caBundle: CaBundle;
  minter: CertMinter;
  credentials: MitmCredentialSource;
  /** Host to bind. Defaults to `"127.0.0.1"`. */
  host?: string;
  /** Upstream fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /**
   * Injectable DNS resolver for the SNI rebind guard (tests stub it so
   * non-resolving `*.local` SNI hosts pass; production uses the system
   * resolver). Only consulted for non-IP-literal SNI hosts.
   */
  resolveHostFn?: HostResolver;
  /** Telemetry sink — non-fatal events surface here. */
  onEvent?: (event: MitmListenerEvent) => void;
}

export type MitmListenerEvent =
  | { kind: "connect-accepted"; host: string; port: number }
  | { kind: "connect-rejected"; reason: string }
  | {
      kind: "request-forwarded";
      url: string;
      method: string;
      status: number;
      authKey: string | null;
      retried: boolean;
      /**
       * Whether the planner produced a header to inject (i.e. the auth
       * matched the URL AND the resolved credential value was non-empty).
       * The value itself is NEVER surfaced — `true`/`false` only — so a
       * platform operator reading the log line can tell a missing-auth
       * scenario apart from an upstream 401 in a single glance.
       */
      headerInjected: boolean;
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
  // Ephemeral port (0 → kernel-assigned, read back from `address()` after `ready`).
  const port = 0;
  const maxRequestBytes = 10 * 1024 * 1024; // 10 MiB inner-request body cap.
  const fetchFn = options.fetch ?? globalThis.fetch;
  const emit = options.onEvent ?? (() => {});

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
          handleInnerRequest(req, sniHost, options.credentials, fetchFn, maxRequestBytes, emit),
      });
    })().catch((err) => {
      // Don't let a transient mint/bring-up failure poison this host for the
      // rest of the run: evict the rejected promise so the next CONNECT retries.
      tlsServers.delete(sniHost);
      throw err;
    });
    tlsServers.set(sniHost, p);
    return p;
  };

  // Outer TCP server: parse CONNECT, peek ClientHello for SNI, relay
  // to the per-SNI Bun.serve.
  const tcpServer = netCreateServer((rawSocket: Socket) => {
    handleInboundConnection(
      rawSocket,
      async (sniHost) => getOrCreateTlsServer(sniHost),
      emit,
      options.resolveHostFn,
    );
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
  resolveHostFn?: HostResolver,
): Promise<void> {
  rawSocket.on("error", () => {
    // Per-connection handlers own teardown.
  });

  // Arm a read timeout for the CONNECT-preamble + ClientHello phase. A silent
  // or stalled client must not pin a socket + pending promise for the whole
  // run. Disarmed once we switch to raw relay (the tunnel is legitimately
  // long-lived). `destroy()` fires `close`, which settles the read promises.
  const HANDSHAKE_READ_TIMEOUT_MS = 30_000;
  rawSocket.setTimeout(HANDSHAKE_READ_TIMEOUT_MS, () => {
    emit({ kind: "connect-rejected", reason: "handshake read timeout" });
    rawSocket.destroy();
  });

  // 1. Parse the CONNECT preamble.
  let preamble = Buffer.alloc(0);
  const MAX_PREAMBLE = 8 * 1024;
  const result = await new Promise<
    | { ok: true; host: string; port: number; remainder: Buffer }
    | { ok: false; reply: string; reason: string }
  >((resolve) => {
    const onClose = () => {
      rawSocket.off("data", onData);
      resolve({ ok: false, reply: "", reason: "socket closed before CONNECT preamble" });
    };
    rawSocket.once("close", onClose);
    const onData = (chunk: Buffer) => {
      preamble = Buffer.concat([preamble, chunk]);
      if (preamble.length > MAX_PREAMBLE) {
        rawSocket.off("data", onData);
        rawSocket.off("close", onClose);
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
      rawSocket.off("close", onClose);
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
    try {
      clientHello = await collectUntilSniParses(rawSocket, clientHello);
    } catch (err) {
      emit({ kind: "tls-error", error: `ClientHello read failed: ${(err as Error).message}` });
      rawSocket.destroy();
      return;
    }
  }

  const sniHost = extractSni(clientHello);
  if (!sniHost) {
    emit({ kind: "tls-error", error: "could not extract SNI from ClientHello" });
    rawSocket.destroy();
    return;
  }

  // SSRF floor: refuse to mint a leaf or relay for a blocked target (cloud
  // IMDS, RFC1918, loopback, link-local, …). The SNI host is controlled by
  // the untrusted integration MCP code, and the sidecar's egress reaches the
  // host network + cloud metadata — so this must run BEFORE any cert mint.
  // Mirrors the credential-proxy SSRF guard; external egress stays open
  // (the per-integration MITM model intentionally forwards to external hosts).
  //
  // Literal layer first (cheap, no DNS) …
  if (isBlockedHost(sniHost)) {
    emit({ kind: "tls-error", error: `SNI host blocked by SSRF policy: ${sniHost}` });
    rawSocket.destroy();
    return;
  }
  // … then the DNS-rebind layer: a public-looking SNI name whose A/AAAA
  // record points inside must not get a minted leaf either. Fail closed on
  // resolution failure. Note: the upstream request is made by `fetch` against
  // the SNI hostname (TLS cert validation needs the name), so this cannot pin
  // the connect to a resolved IP — it is fail-closed defence-in-depth with a
  // residual resolver TOCTOU, same stance as the platform's `ssrf-dns` guard.
  const sniCheck = await resolveAndCheckHost(sniHost, { resolve: resolveHostFn });
  if (sniCheck.blocked) {
    const why =
      sniCheck.reason === "resolution-failed"
        ? `SNI host DNS resolution failed (fail closed): ${sniHost}`
        : `SNI host resolves into a blocked range (DNS rebind): ${sniHost}`;
    emit({ kind: "tls-error", error: why });
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
  //    the upstream first, then pipe both directions. Disarm the handshake
  //    read timeout — the tunnel is now legitimately long-lived.
  rawSocket.setTimeout(0);
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
    rawSocket.once("close", () => reject(new Error("socket closed before SNI")));
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
function extractSni(buf: Buffer): string | null {
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
// Connect-login transient-input substitution (P1)
// ─────────────────────────────────────────────

/**
 * Result of {@link applyConnectInputSubstitution}: either the substituted
 * request parts, or a fail-closed marker carrying the first unresolved
 * placeholder name.
 */
export type ConnectInputSubstitutionResult =
  | { url: string; bodyText: string | null; headers: Record<string, string> }
  | { failed: string };

/**
 * Pure, unit-testable helper for connect-login transient-input
 * substitution. Runs {@link substituteVars} over the URL, body, and each
 * header value using `inputs`, then re-checks each field with
 * {@link findUnresolvedPlaceholders}.
 *
 * Fail-closed contract: if any field that originally contained a `{{...}}`
 * placeholder still contains one after substitution, we return
 * `{ failed: <name> }` rather than forwarding a half-substituted value
 * upstream. A literal secret/placeholder must NEVER leak upstream nor into
 * a tool result — refusing the request is the only safe outcome.
 *
 * Fields that never contained a placeholder are passed through untouched
 * (substituteVars is a no-op on them), so a request with no placeholders is
 * returned verbatim.
 */
export function applyConnectInputSubstitution(
  parts: { url: string; bodyText: string | null; headers: Record<string, string> },
  inputs: Record<string, string>,
): ConnectInputSubstitutionResult {
  const checkField = (original: string, substituted: string): string | null => {
    // Only fail-closed when the ORIGINAL field carried a placeholder. A
    // field that legitimately contains `{{...}}`-looking text but was never
    // a substitution target (no placeholder before substitution) can't have
    // a half-substituted secret in it — but here `original === substituted`
    // for a field with no resolvable placeholder, so we gate on whether the
    // original had any placeholder at all.
    if (findUnresolvedPlaceholders(original).length === 0) return null;
    const remaining = findUnresolvedPlaceholders(substituted);
    return remaining.length > 0 ? remaining[0]! : null;
  };

  const url = substituteVars(parts.url, inputs);
  const urlFail = checkField(parts.url, url);
  if (urlFail) return { failed: urlFail };

  let bodyText: string | null = null;
  if (parts.bodyText !== null) {
    bodyText = substituteVars(parts.bodyText, inputs);
    const bodyFail = checkField(parts.bodyText, bodyText);
    if (bodyFail) return { failed: bodyFail };
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(parts.headers)) {
    const sub = substituteVars(v, inputs);
    const headerFail = checkField(v, sub);
    if (headerFail) return { failed: headerFail };
    headers[k] = sub;
  }

  return { url, bodyText, headers };
}

/**
 * True when `url` matches at least one of the acquiring auth's authorized-URI
 * specs — the guard that binds transient-secret substitution to authorized
 * targets. Empty allowlist matches nothing (fail-closed): a connect-login must
 * declare the login endpoint in its auth's URL envelope.
 */
function targetWithinAuthorizedUris(url: string, authorizedUris: readonly string[]): boolean {
  for (const spec of authorizedUris) {
    if (matchesAuthorizedUriSpec(spec, url)) return true;
  }
  return false;
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
): Promise<Response> {
  // Re-build the upstream URL from the SNI host + request path. Bun
  // gives us the absolute URL but it points at our local 127.0.0.1
  // listener — we replace the origin with the SNI host (port 443).
  const incoming = new URL(req.url);
  let targetUrl = `https://${sniHost}${incoming.pathname}${incoming.search}`;

  // Read the body up-front. Connect-login substitution (below) may need
  // to rewrite it, and the planner check must run on the SUBSTITUTED url,
  // so the body read can no longer be deferred past it.
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

  // The Headers we forward downstream. When a connect-login is in flight we
  // replace the inbound values with their substituted counterparts so the
  // raw login secret reaches upstream proxy-side only — never the tool code
  // and never a tool result.
  let headersForOutbound = req.headers;

  // Connect-login transient-input substitution (P1). Runs BEFORE
  // `planMitmAction`, so the credential header only materialises for a
  // request that will actually be forwarded. Fail-closed: an unresolved
  // placeholder refuses the request rather than forwarding a
  // half-substituted literal upstream.
  //
  // SECURITY (bind to authorizedUris): the transient secret is substituted
  // ONLY when the request targets one of the acquiring auth's authorized URIs.
  // Without this bound, an untrusted login tool could aim a `{{secret}}`
  // request at an arbitrary host and exfiltrate the secret off-target. A
  // request to an off-allowlist host is forwarded WITHOUT substitution (any
  // `{{...}}` literal it carries stays a literal — a placeholder name, never
  // the secret value).
  const active = credentials.activeInputs?.() ?? null;
  if (active && targetWithinAuthorizedUris(targetUrl, active.authorizedUris)) {
    const inboundHeaders: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      inboundHeaders[k] = v;
    });
    const bodyText = body.byteLength > 0 ? body.toString("utf-8") : null;
    const result = applyConnectInputSubstitution(
      { url: targetUrl, bodyText, headers: inboundHeaders },
      active.inputs,
    );
    if ("failed" in result) {
      emit({ kind: "request-refused", url: targetUrl, reason: "unresolved login placeholder" });
      return new Response("MITM listener: unresolved login placeholder", { status: 400 });
    }
    targetUrl = result.url;
    if (result.bodyText !== null) body = Buffer.from(result.bodyText, "utf-8");
    const subbed = new Headers();
    for (const [k, v] of Object.entries(result.headers)) subbed.set(k, v);
    headersForOutbound = subbed;
  }

  const callerHeaderNames: string[] = [];
  headersForOutbound.forEach((_v, k) => callerHeaderNames.push(k));

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
    headersForOutbound,
    sniHost,
    action.strippedHeaderNames,
    action.injectedHeader,
  );

  // SSRF defense-in-depth: the SNI host was checked at CONNECT, but the
  // connect-login substitution above can rewrite `targetUrl` — re-check the
  // final URL before egress (mirrors credential-proxy).
  if (isBlockedUrl(targetUrl)) {
    emit({ kind: "request-refused", url: targetUrl, reason: "target blocked by SSRF policy" });
    return new Response("MITM listener: target blocked by SSRF policy", { status: 403 });
  }

  let response: Response;
  try {
    response = await fetchFn(targetUrl, {
      method: req.method,
      headers: outboundHeaders,
      ...(body.byteLength > 0 ? { body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    });
  } catch (err) {
    emit({ kind: "upstream-error", url: targetUrl, error: (err as Error).message });
    return new Response(`MITM upstream error: ${(err as Error).message}`, { status: 502 });
  }

  // Recovery paths converge here:
  //   - Any 401 on an auth whose credential we INJECTED forces a platform
  //     refresh. For OAuth it rotates the token and we retry once; for a
  //     non-OAuth auth (api_key/basic) the platform `/refresh` has nothing to
  //     refresh after a 401, so it flags the connection needsReconnection and
  //     returns false — no retry. This is what restores "a terminal 401
  //     invalidates the connection" for EVERY auth type (the 401-is-about-our-
  //     credential gate = injectedHeader !== null; a 403 is left untouched).
  //   - connect.tool re-login (P3): a status the manifest's `reauth_on`
  //     declares (default `[401]`) re-runs the login tool; `setSessionOutputs`
  //     updates the source's deliveryPlans so the rebuilt action injects the
  //     fresh session header.
  const matchedAuthKey = action.matchedAuth?.authKey ?? null;
  const got401 = response.status === 401 && !!action.matchedAuth && action.injectedHeader !== null;
  const connectReauth =
    !!action.matchedAuth &&
    matchedAuthKey !== null &&
    credentials.shouldReauth?.(matchedAuthKey, response.status) === true;
  // A connect.tool session auth whose `reauth_on` deliberately EXCLUDES this
  // status (`shouldReauth` false but a re-login handler IS registered): the
  // manifest declared this 401 is NOT a session-death signal. Leave the
  // response untouched — no stale replay, no re-login, no flag (the pre-P3
  // pass-through). Without this gate the auth would be mistaken for a dead
  // static credential (replayed + flagged) AND re-logged-in regardless, since
  // `refreshOnUnauthorized` runs the handler without re-checking the status.
  const reauthExcluded =
    got401 &&
    !connectReauth &&
    matchedAuthKey !== null &&
    credentials.hasReloginHandler?.(matchedAuthKey) === true;
  let retried = false;
  let lastAction = action;

  // Rebuild the action from the source's CURRENT state (fresh after a refresh /
  // re-login, identical for a same-credential replay) and re-issue the request
  // once. Returns the new response, or null if the retry threw.
  const refetch = async (): Promise<Response | null> => {
    const a = buildAction();
    lastAction = a;
    const outbound = buildOutboundHeaders(
      headersForOutbound,
      sniHost,
      a.strippedHeaderNames,
      a.injectedHeader,
    );
    try {
      return await fetchFn(targetUrl, {
        method: req.method,
        headers: outbound,
        ...(body.byteLength > 0 ? { body } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      emit({ kind: "upstream-error", url: targetUrl, error: `retry: ${(err as Error).message}` });
      return null;
    }
  };

  // A 401 on our injected credential (or a connect.tool re-login trigger):
  // force a platform refresh — rotates the token for oauth, flags the
  // connection needsReconnection for a non-oauth auth (nothing to refresh after
  // a 401). A successful refresh / re-login replays the request once.
  if (
    (got401 || connectReauth) &&
    !reauthExcluded &&
    matchedAuthKey !== null &&
    credentials.refreshOnUnauthorized
  ) {
    const refreshed = await credentials.refreshOnUnauthorized(matchedAuthKey).catch(() => false);
    if (refreshed) {
      const replay = await refetch();
      if (replay) {
        response = replay;
        retried = true;
      }
    }
  }

  emit({
    kind: "request-forwarded",
    url: targetUrl,
    method: req.method,
    status: response.status,
    authKey: lastAction.matchedAuth?.authKey ?? null,
    retried,
    headerInjected: lastAction.injectedHeader !== null,
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
    // Set-Cookie is handled below to preserve multiplicity — Headers.forEach
    // folds repeated Set-Cookie into one comma-joined value, and `.set` would
    // overwrite. A cookie-session login (e.g. a connect.tool tool building its
    // own jar across the redirect chain) needs each Set-Cookie intact, and
    // expiry dates inside them contain commas — folding is lossy/ambiguous.
    if (lower === "set-cookie") return;
    headers.set(k, v);
  });
  const getSetCookie = (response.headers as { getSetCookie?: () => string[] }).getSetCookie;
  const setCookies = typeof getSetCookie === "function" ? getSetCookie.call(response.headers) : [];
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ─────────────────────────────────────────────
// CONNECT preamble parsing
// ─────────────────────────────────────────────

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
