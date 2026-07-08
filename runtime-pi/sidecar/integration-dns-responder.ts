// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal per-run DNS responder for transparent integration egress (#779).
 *
 * A `delivery.env` integration runner previously reached the outside world
 * only through a plain CONNECT proxy handed to it as `HTTPS_PROXY`. That
 * contract assumes a cooperative HTTP client — but most third-party MCP
 * servers ship clients that either ignore proxy env vars entirely
 * (undici/`fetch`) or speak non-CONNECT forward-proxy for HTTPS (axios),
 * so their egress silently dies (405 / connect timeout).
 *
 * The fix is to make the runner's egress *transparent*: this responder
 * answers every external A query with the sidecar's own IP on the per-run
 * bridge network, so the runner's direct `connect(host, 443)` lands on the
 * sidecar's SNI-passthrough listener ({@link createTransparentEgressListener})
 * which applies the same SSRF floor as the CONNECT path and blind-splices
 * raw TLS to the real upstream. The runner's HTTP client never knows a
 * proxy exists — its library choice becomes irrelevant.
 *
 * Wire-level scope (deliberately tiny — this is not a general resolver):
 *   - A queries   → answer with the configured sidecar IPv4, TTL 1.
 *   - AAAA queries → NOERROR with zero answers (forces the client's
 *     happy-eyeballs down to A / IPv4 — the per-run bridge is IPv4-only).
 *   - Any other qtype → NOERROR, zero answers.
 *   - Malformed / non-query packets → dropped (no response).
 *
 * Docker's embedded DNS (127.0.0.11) still serves network aliases
 * (`sidecar`) locally and only *forwards* external names here (`--dns`
 * upstream), so intra-network resolution is untouched. On Docker ≥ 27 the
 * embedded resolver forwards from inside the container's network
 * namespace, which is what makes an upstream that lives on the same
 * `internal: true` bridge reachable at all.
 */

import { createSocket, type Socket, type RemoteInfo } from "node:dgram";

export interface DnsResponderEvent {
  kind: "query-answered" | "query-empty" | "query-dropped";
  /** Lowercased QNAME when parseable; empty string otherwise. */
  name: string;
  /** Numeric query type (1 = A, 28 = AAAA) when parseable. */
  qtype?: number;
}

export interface CreateDnsResponderOptions {
  /** IPv4 (dotted quad) every external A query resolves to. */
  answerIpv4: string;
  /** Bind host — 0.0.0.0 on a bridged network. */
  host?: string;
  /** Bind port — 53 in production; tests pass 0 for an ephemeral port. */
  port?: number;
  /** Telemetry sink (names + outcome only — never payloads). */
  onEvent?: (event: DnsResponderEvent) => void;
}

export interface DnsResponderHandle {
  ready: Promise<void>;
  address(): { host: string; port: number };
  close(): Promise<void>;
}

const QTYPE_A = 1;

/** Strict dotted-quad check — four octets, each 0-255 (rejects `256.0.0.1`). */
function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** DNS header flags for a standard authoritative-ish response: QR=1, RD copied, RA=1. */
function responseFlags(queryFlags: number): number {
  const rd = queryFlags & 0x0100;
  return 0x8000 | rd | 0x0080; // QR | RD | RA, RCODE 0
}

/**
 * Parse the question section of a DNS query. Returns null on anything
 * that isn't a single-question standard query (we never answer those —
 * dropping is safer than guessing).
 */
function parseQuestion(
  msg: Buffer,
): { id: number; flags: number; name: string; qtype: number; questionEnd: number } | null {
  if (msg.length < 12) return null;
  const id = msg.readUInt16BE(0);
  const flags = msg.readUInt16BE(2);
  if ((flags & 0x8000) !== 0) return null; // QR=1 → a response, not a query
  const qdcount = msg.readUInt16BE(4);
  if (qdcount !== 1) return null;
  // Walk the QNAME labels. Compression pointers are illegal in a question
  // (nothing earlier to point at) — reject them.
  let offset = 12;
  const labels: string[] = [];
  while (true) {
    if (offset >= msg.length) return null;
    const len = msg[offset]!;
    if (len === 0) {
      offset += 1;
      break;
    }
    if ((len & 0xc0) !== 0) return null; // compression / reserved bits
    if (offset + 1 + len > msg.length) return null;
    labels.push(msg.subarray(offset + 1, offset + 1 + len).toString("latin1"));
    offset += 1 + len;
    if (labels.length > 127) return null;
  }
  if (offset + 4 > msg.length) return null;
  const qtype = msg.readUInt16BE(offset);
  return { id, flags, name: labels.join(".").toLowerCase(), qtype, questionEnd: offset + 4 };
}

/**
 * Build the response packet: original header id, response flags, the
 * question echoed verbatim, and (for A queries) a single A record
 * answering with `answerIpv4`. EDNS OPT records in the query's additional
 * section are ignored — a sub-512-byte response never needs them.
 */
function buildResponse(
  msg: Buffer,
  q: { id: number; flags: number; qtype: number; questionEnd: number },
  answerIpv4: string,
): Buffer {
  const answerCount = q.qtype === QTYPE_A ? 1 : 0;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(q.id, 0);
  header.writeUInt16BE(responseFlags(q.flags), 2);
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(answerCount, 6); // ANCOUNT
  const question = msg.subarray(12, q.questionEnd);
  if (answerCount === 0) return Buffer.concat([header, question]);
  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0); // compression pointer to QNAME at offset 12
  answer.writeUInt16BE(QTYPE_A, 2);
  answer.writeUInt16BE(1, 4); // CLASS IN
  answer.writeUInt32BE(1, 6); // TTL 1s — per-run infra, keep caches honest
  answer.writeUInt16BE(4, 10); // RDLENGTH
  const octets = answerIpv4.split(".").map((o) => Number(o));
  answer.set(octets, 12);
  return Buffer.concat([header, question, answer]);
}

/** Create the responder on the given host/port. UDP only — queries this tiny never truncate. */
export function createIntegrationDnsResponder(
  options: CreateDnsResponderOptions,
): DnsResponderHandle {
  const { answerIpv4 } = options;
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 53;
  const emit = options.onEvent ?? (() => {});

  if (!isValidIpv4(answerIpv4)) {
    throw new Error(`integration-dns-responder: invalid answer IPv4 '${answerIpv4}'`);
  }

  const socket: Socket = createSocket("udp4");

  socket.on("message", (msg: Buffer, rinfo: RemoteInfo) => {
    const q = parseQuestion(msg);
    if (!q) {
      emit({ kind: "query-dropped", name: "" });
      return;
    }
    const response = buildResponse(msg, q, answerIpv4);
    socket.send(response, rinfo.port, rinfo.address);
    emit({
      kind: q.qtype === QTYPE_A ? "query-answered" : "query-empty",
      name: q.name,
      qtype: q.qtype,
    });
  });

  let readyResolve!: () => void;
  let readyReject!: (err: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  socket.once("error", (err) => readyReject(err));
  socket.bind(port, host, () => {
    // Post-bind errors (send failures on a torn-down socket, …) must not
    // crash the sidecar — swallow them; the transparent path degrades and
    // the runner sees a DNS timeout, same failure mode as before #779.
    socket.removeAllListeners("error");
    socket.on("error", () => {});
    readyResolve();
  });

  return {
    ready,
    address() {
      const a = socket.address();
      return { host: a.address, port: a.port };
    },
    close() {
      return new Promise<void>((res) => socket.close(() => res()));
    },
  };
}
