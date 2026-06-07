// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Issue #403 — a `fetch`-shaped wrapper over the `curl` CLI.
 *
 * Some upstreams (behind Cloudflare / Akamai Bot Manager, or with JA3/JA4 TLS
 * fingerprinting) reject the TLS ClientHello emitted by Bun/undici `fetch`
 * because it doesn't match a real browser. Routing the request through `curl` —
 * which has its own TLS stack — or, for SOTA browser mimicry, through
 * `curl-impersonate` (replicates Chrome/Firefox cipher suites, extension order,
 * GREASE values, and HTTP/2 settings exactly), presents a fingerprint the
 * upstream accepts.
 *
 * This module spawns `curl` per request and adapts its output back into a
 * {@link Response}, so it drops into any code path that takes an injected
 * `fetch` implementation (see {@link ./tls-client-router.ts}). The MITM listener
 * has already terminated the runner↔listener TLS, so swapping the
 * listener↔upstream client to curl only changes which ClientHello reaches the
 * real upstream — credential injection, SSRF checks, and response passthrough
 * are unchanged.
 *
 * Scope discipline:
 *   - `redirect: "manual"` only — curl runs without `-L`, so a 3xx is returned
 *     verbatim (the MITM listener never followed redirects either).
 *   - `--compressed` so curl decompresses gzip/br/zstd, matching Bun `fetch`
 *     (the listener's `passthroughResponse` strips `content-encoding`).
 *   - Response is buffered (not streamed) and capped at {@link ABSOLUTE_MAX_RESPONSE_SIZE}.
 */

import { ABSOLUTE_MAX_RESPONSE_SIZE, OUTBOUND_TIMEOUT_MS } from "./helpers.ts";

// The sidecar's tsconfig omits the DOM lib, so the `HeadersInit` / `BodyInit` /
// `RequestInfo` aliases aren't global. Derive the exact shapes the Bun globals
// accept from their own signatures.
export type FetchInput = Parameters<typeof fetch>[0];
export type FetchInit = Parameters<typeof fetch>[1];
type HeadersInitLike = ConstructorParameters<typeof Headers>[0];
type ResponseBodyLike = ConstructorParameters<typeof Response>[0];

/** Spawn signature compatible with `Bun.spawn` (only the fields this module uses). */
export type CurlSpawnFn = (
  cmd: string[],
  opts: {
    stdin?: "ignore" | "pipe" | Uint8Array;
    stdout: "pipe";
    stderr: "pipe";
  },
) => {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill: (signal?: number) => void;
};

export interface CurlRunnerConfig {
  /** Binary for plain (non-impersonating) curl. */
  curlBin: string;
  /** Binary for `curl-impersonate` (browser TLS mimicry). */
  impersonateBin: string;
  /** Spawn implementation — `Bun.spawn` in prod, a fake in tests. */
  spawn: CurlSpawnFn;
  /** Per-request wall-clock budget (ms). */
  timeoutMs: number;
  /** Hard cap on the buffered response body (bytes). */
  maxBytes: number;
}

/** Subset of `RequestInit` the curl runner honours, plus the impersonate target. */
export interface CurlRequestInit {
  method?: string;
  headers?: HeadersInitLike;
  body?: ResponseBodyLike | Buffer | Uint8Array | null;
  signal?: AbortSignal | null;
  /** `curl-impersonate` target browser (e.g. `"chrome"`). Absent → plain curl. */
  impersonate?: string;
}

/** Thrown when curl spawn fails, the process exits non-zero, or output is unparsable. */
export class CurlRunnerError extends Error {
  constructor(
    message: string,
    readonly code: "SPAWN_FAILED" | "NONZERO_EXIT" | "UNPARSABLE_RESPONSE" | "RESPONSE_TOO_LARGE",
    readonly stderr?: string,
  ) {
    super(message);
    this.name = "CurlRunnerError";
  }
}

/** Resolve `Bun.spawn` for production use. */
function resolveBunSpawn(): CurlSpawnFn {
  const fn = (globalThis as unknown as { Bun?: { spawn?: unknown } }).Bun?.spawn as
    | CurlSpawnFn
    | undefined;
  if (!fn) {
    throw new CurlRunnerError(
      "Bun.spawn is not available — curl routing requires the Bun runtime",
      "SPAWN_FAILED",
    );
  }
  return fn;
}

/**
 * Build a {@link CurlRunnerConfig} from the environment with sane defaults.
 * Binaries are overridable so an operator can point at a vendored
 * curl-impersonate build (env `TLS_CLIENT_CURL_BIN` / `TLS_CLIENT_CURL_IMPERSONATE_BIN`).
 */
export function resolveCurlRunnerConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<CurlRunnerConfig> = {},
): CurlRunnerConfig {
  return {
    curlBin: overrides.curlBin ?? env.TLS_CLIENT_CURL_BIN ?? "curl",
    impersonateBin:
      overrides.impersonateBin ?? env.TLS_CLIENT_CURL_IMPERSONATE_BIN ?? "curl-impersonate",
    spawn: overrides.spawn ?? resolveBunSpawn(),
    timeoutMs: overrides.timeoutMs ?? OUTBOUND_TIMEOUT_MS,
    maxBytes: overrides.maxBytes ?? ABSOLUTE_MAX_RESPONSE_SIZE,
  };
}

/** Normalise any supported body into bytes (or null when there is no body). */
async function bodyToBytes(body: CurlRequestInit["body"]): Promise<Uint8Array | null> {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  // Blob / ReadableStream / FormData / URLSearchParams — let Response buffer it.
  const ab = await new Response(body as ResponseBodyLike).arrayBuffer();
  return new Uint8Array(ab);
}

/** Lowercase header name → values, preserving the entries of any HeadersInit shape. */
function headerEntries(headers: HeadersInitLike | undefined): Array<[string, string]> {
  if (!headers) return [];
  const h = new Headers(headers);
  const out: Array<[string, string]> = [];
  h.forEach((v, k) => out.push([k, v]));
  return out;
}

/** Drain a byte stream into one Uint8Array. */
async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

const CRLFCRLF = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);
const LFLF = new Uint8Array([0x0a, 0x0a]);

/** Index of the first occurrence of `needle` in `hay` at/after `from`, or -1. */
function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

interface ParsedHeadBlock {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  bodyStart: number;
}

/**
 * Parse one HTTP header block out of curl's `-D -` output. Returns the parsed
 * status/headers and the byte offset where this block's body begins. 1xx
 * informational blocks (e.g. `100 Continue`) are skipped by the caller.
 */
function parseHeadBlock(buf: Uint8Array, from: number): ParsedHeadBlock | null {
  let sep = indexOfBytes(buf, CRLFCRLF, from);
  let sepLen = CRLFCRLF.length;
  if (sep === -1) {
    sep = indexOfBytes(buf, LFLF, from);
    sepLen = LFLF.length;
  }
  if (sep === -1) return null;
  const head = new TextDecoder().decode(buf.subarray(from, sep));
  const lines = head.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const statusLine = lines[0]!;
  // `HTTP/1.1 200 OK` or `HTTP/2 200` (h2 has no reason phrase).
  const m = /^HTTP\/[\d.]+\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
  if (!m) return null;
  const status = Number.parseInt(m[1]!, 10);
  const statusText = m[2]?.trim() ?? "";
  const headers: Array<[string, string]> = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.length > 0) headers.push([name, value]);
  }
  return { status, statusText, headers, bodyStart: sep + sepLen };
}

/** Build the curl argv for one request. */
function buildArgs(url: string, init: CurlRequestInit, cfg: CurlRunnerConfig, hasBody: boolean) {
  const method = (init.method ?? "GET").toUpperCase();
  const bin = init.impersonate ? cfg.impersonateBin : cfg.curlBin;
  // `-q` MUST be first so curl ignores any ambient curlrc.
  const args: string[] = ["-q"];
  if (init.impersonate) args.push("--impersonate", init.impersonate);
  args.push(
    "--silent",
    "--show-error",
    "-D",
    "-", // dump response headers to stdout, before the body
    "--compressed", // decompress gzip/br/zstd, matching Bun fetch
    "--max-time",
    String(Math.max(1, Math.ceil(cfg.timeoutMs / 1000))),
    "--max-filesize",
    String(cfg.maxBytes),
    "-X",
    method,
  );
  let sawExpect = false;
  for (const [k, v] of headerEntries(init.headers)) {
    if (k.toLowerCase() === "expect") sawExpect = true;
    args.push("-H", `${k}: ${v}`);
  }
  // Suppress the `Expect: 100-continue` preface so the output has exactly one
  // header block (unless the caller deliberately set Expect themselves).
  if (!sawExpect) args.push("-H", "Expect:");
  if (hasBody) args.push("--data-binary", "@-");
  args.push("--", url);
  return { bin, args };
}

/**
 * Perform one upstream request via the curl CLI and adapt the result into a
 * {@link Response}. Drop-in compatible with the `fetch` calls in the MITM
 * listener (`{ method, headers, body, redirect: "manual", signal }`).
 */
export async function curlFetch(
  url: string,
  init: CurlRequestInit,
  cfg: CurlRunnerConfig,
): Promise<Response> {
  if (init.signal?.aborted) {
    throw new CurlRunnerError("request aborted before curl spawn", "SPAWN_FAILED");
  }
  const bodyBytes = await bodyToBytes(init.body);
  const { bin, args } = buildArgs(url, init, cfg, bodyBytes !== null);

  let proc: ReturnType<CurlSpawnFn>;
  try {
    proc = cfg.spawn([bin, ...args], {
      stdin: bodyBytes ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    throw new CurlRunnerError(
      `failed to spawn '${bin}': ${(err as Error).message}`,
      "SPAWN_FAILED",
    );
  }

  const onAbort = () => proc.kill();
  init.signal?.addEventListener("abort", onAbort, { once: true });

  let stdout: Uint8Array;
  let stderr: string;
  let code: number;
  try {
    [stdout, stderr] = await Promise.all([
      collectBytes(proc.stdout),
      collectBytes(proc.stderr).then((b) => new TextDecoder().decode(b)),
    ]);
    code = await proc.exited;
  } finally {
    init.signal?.removeEventListener("abort", onAbort);
  }

  if (code !== 0) {
    throw new CurlRunnerError(
      `curl exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
      "NONZERO_EXIT",
      stderr,
    );
  }

  // Skip any leading 1xx informational header blocks, then parse the final one.
  let parsed = parseHeadBlock(stdout, 0);
  while (parsed && parsed.status >= 100 && parsed.status < 200) {
    parsed = parseHeadBlock(stdout, parsed.bodyStart);
  }
  if (!parsed) {
    throw new CurlRunnerError("could not parse curl response head", "UNPARSABLE_RESPONSE", stderr);
  }

  const body = stdout.subarray(parsed.bodyStart);
  if (body.byteLength > cfg.maxBytes) {
    throw new CurlRunnerError(
      `curl response body ${body.byteLength} exceeds cap ${cfg.maxBytes}`,
      "RESPONSE_TOO_LARGE",
      stderr,
    );
  }

  const headers = new Headers();
  for (const [k, v] of parsed.headers) {
    // Preserve Set-Cookie multiplicity (append, never set).
    if (k.toLowerCase() === "set-cookie") headers.append(k, v);
    else headers.append(k, v);
  }

  // 204/304 and other no-body statuses must carry a null body.
  const nullBody = parsed.status === 204 || parsed.status === 304;
  return new Response(nullBody ? null : body, {
    status: parsed.status,
    statusText: parsed.statusText,
    headers,
  });
}
