// SPDX-License-Identifier: Apache-2.0

/**
 * Curl-based fetch shim. Mirrors enough of the `fetch(url, init)`
 * contract for the credential-proxy core (`credential-proxy.ts`) to
 * dispatch through `curl` instead of Bun/undici when a provider's
 * `x-tlsClientByUrl` extension declares a matching URL pattern.
 *
 * Why this exists
 * ───────────────
 * Some upstreams (typically behind Cloudflare, Akamai Bot Manager, or
 * with JA3/JA4 TLS fingerprinting) reject Bun/Node-style clients
 * because the TLS `ClientHello` doesn't match a real browser. Routing
 * through `curl` clears plain ClientHello mismatch checks for many
 * such providers. For harder JA4-fingerprinting upstreams, the
 * follow-up is `curl-impersonate` — a Docker base-image swap with no
 * API change at this layer (issue #403).
 *
 * Security posture
 * ────────────────
 * - Argv-only `Bun.spawn(["curl", …])`. No shell. No string
 *   interpolation. Every value reaches curl as a discrete argv entry.
 * - Headers go through `-H "name: value"`. We refuse header names
 *   containing CR/LF (header-splitting defence in depth — Bun's fetch
 *   already rejects them, but curl is now in the loop).
 * - Body goes via stdin (`--data-binary @-`) so payloads of any size
 *   bypass the OS arg cap and are never written to disk.
 * - HTTPS-only by default — `curl-runner` refuses `http://` URLs so
 *   an upstream silent downgrade can't strip TLS while still claiming
 *   "we used curl". Callers that explicitly need plain HTTP must
 *   declare `client: "undici"` in `x-tlsClientByUrl`.
 * - Redirects are off by default and only enabled when `init.redirect`
 *   is explicitly `"follow"` (matches the fetch default of `"follow"`
 *   for the WHATWG spec, but we keep the choice explicit so the proxy
 *   path can short-circuit redirect handling at a higher layer).
 * - Curl's stderr is captured separately, logged at debug level, and
 *   never returned as the upstream response body.
 *
 * Exit-code → HTTP-status mapping (defensive; full list at
 * https://curl.se/libcurl/c/libcurl-errors.html):
 *   - 0          → upstream Response (parsed normally)
 *   - 6, 7       → 502 (DNS/connect failure)
 *   - 28         → 504 (timeout)
 *   - 35, 51, 60 → 502 (SSL handshake / cert problem)
 *   - other      → 502 (logged at debug; opaque body for security)
 */

import { logger } from "./logger.ts";

/**
 * Hard ceiling on curl's stdout buffer. Mirrors `MAX_STREAMED_BODY_SIZE`
 * in `helpers.ts` (100 MB) — kept as a local constant to avoid pulling
 * the helpers module's transitive deps into this leaf file. If the
 * helpers cap changes, change this one too (covered by integration via
 * `credential-proxy.test.ts`).
 */
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Subset of `RequestInit` consumed by {@link curlFetch}. Extends with
 * `proxyUrl` (curl-specific routing; Bun's fetch reads `proxy`
 * directly) and `timeoutMs` (caller-supplied — must be set explicitly).
 * `signal` is honoured for cancellation (kills the child on abort) —
 * deadline extraction from `AbortSignal.timeout()` would have to reach
 * for Bun-version-private fields, so we don't.
 */
export interface CurlFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | string | Uint8Array | undefined;
  redirect?: "follow" | "manual" | "error";
  signal?: AbortSignal;
  proxyUrl?: string | undefined;
  timeoutMs?: number;
}

/**
 * Maximum stderr we'll buffer from a curl child. Curl's verbose
 * tracing on a stuck connection can produce arbitrary bytes; we
 * never surface stderr to the agent, but we don't want a runaway
 * child to OOM the sidecar either.
 */
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * Default outbound timeout when neither `signal` nor `timeoutMs` is
 * provided. Mirrors `OUTBOUND_TIMEOUT_MS` from `helpers.ts` so the
 * curl path and the undici path enforce the same ceiling.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Allowed HTTP methods on the curl path. Restrictive allowlist —
 * `init.method` is LLM-controlled via `provider_call`, and curl
 * writes `-X` straight into the request line, so a CRLF or arbitrary
 * token here would let a misbehaving caller splice extra request
 * lines onto the wire. Any method outside this set is rejected with
 * a synthetic 400 before spawn.
 */
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/**
 * Spawn `curl` and return an HTTP `Response` shaped exactly like
 * Bun's `fetch()` produces. Status, headers, and body round-trip
 * verbatim; non-zero exit codes are mapped to synthetic 502/504
 * responses so the rest of `credential-proxy.ts` can keep treating
 * the result as a regular upstream `Response`.
 */
export async function curlFetch(
  url: string,
  init: CurlFetchInit = {},
  spawnFn: typeof Bun.spawn = Bun.spawn,
): Promise<Response> {
  // 1. Reject plain HTTP up-front. The whole point of routing through
  //    curl is to clear TLS fingerprint checks — letting it fall back
  //    to plaintext would silently defeat the security posture.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return synthResponse(502, "curl-runner: invalid URL", url);
  }
  if (parsed.protocol !== "https:") {
    return synthResponse(502, `curl-runner: refused non-HTTPS URL (got ${parsed.protocol})`, url);
  }

  // 2. Build argv. Order matters only for readability; curl itself is
  //    order-agnostic for these flags.
  const method = (init.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return synthResponse(400, `curl-runner: refused method "${method}"`, url);
  }
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));

  const args: string[] = [
    // Silent (no progress meter) + show errors on stderr.
    "--silent",
    "--show-error",
    // Emit response headers as `HTTP/1.1 200 …\r\nHeader: Value\r\n…\r\n\r\n`
    // followed by the body, so we can parse status + headers off
    // stdout without an extra `-D <fd>` redirection.
    "--include",
    // Don't let curl interpret stray `-` as stdin for URL parsing —
    // `--` terminates option parsing later.
    "--max-time",
    String(timeoutSeconds),
    // HTTPS hardening — no insecure fallbacks. The whole point of
    // taking the curl path is "we want a real browser-like TLS
    // handshake", so cert validation is non-negotiable.
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    "-X",
    method,
  ];

  if (init.redirect === "follow") {
    args.push("-L");
    // Cap redirect hops to avoid loops.
    args.push("--max-redirs", "10");
  }

  if (init.proxyUrl) {
    args.push("-x", init.proxyUrl);
  }

  // 3. Headers. Reject CR/LF in names or values — both are header
  //    splitting vectors. Bun's fetch path already does this; we
  //    enforce again here because curl is a fresh trust boundary.
  if (init.headers) {
    for (const [name, value] of Object.entries(init.headers)) {
      if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
        return synthResponse(400, `curl-runner: header "${name}" contains CR/LF — refused`, url);
      }
      args.push("-H", `${name}: ${value}`);
    }
  }

  // 4. Body via stdin. `--data-binary @-` makes curl read the body
  //    from stdin without any transformations (no URL-encoding, no
  //    line ending changes — exactly what `fetch` does with raw bytes).
  let bodyBytes: Uint8Array | undefined;
  if (init.body !== undefined && init.body !== null) {
    bodyBytes = toBytes(init.body);
    args.push("--data-binary", "@-");
  }

  // 5. Terminator so curl never interprets the URL as an option.
  args.push("--", url);

  // 6. Spawn. Argv-only — `Bun.spawn(["curl", …argv])`. No shell.
  const child = spawnFn({
    cmd: ["curl", ...args],
    stdin: bodyBytes ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Honour caller-supplied AbortSignal — kill the child on abort so
  // a cancelled run doesn't leave curl running for `--max-time`
  // seconds (defeats the cancel pub/sub contract).
  const onAbort = (): void => {
    try {
      (child as unknown as { kill?: (signal?: number) => void }).kill?.();
    } catch {
      // Best-effort — process may have already exited.
    }
  };
  if (init.signal) {
    if (init.signal.aborted) onAbort();
    else init.signal.addEventListener("abort", onAbort, { once: true });
  }

  // Write body to stdin (if any), then close. Bun.spawn returns a
  // FileSink for stdin when "pipe" — keep the write defensive in case
  // a future Bun release changes the shape.
  if (
    bodyBytes &&
    child.stdin &&
    typeof (child.stdin as { write?: unknown }).write === "function"
  ) {
    const sink = child.stdin as { write: (data: Uint8Array) => void; end?: () => void };
    sink.write(bodyBytes);
    sink.end?.();
  }

  // 7. Drain stdout / stderr concurrently. Both have hard caps so a
  //    misbehaving upstream returning a 10 GB body or a flapping
  //    child spewing stderr cannot OOM the sidecar — matches the
  //    fetch path's `MAX_STREAMED_BODY_SIZE` ceiling.
  const [stdoutResult, stderrSnippet, exitCode] = await Promise.all([
    readAllCapped(child.stdout, MAX_RESPONSE_BYTES, onAbort),
    readCapped(child.stderr, MAX_STDERR_BYTES),
    child.exited,
  ]);
  if (init.signal) init.signal.removeEventListener("abort", onAbort);

  if (stdoutResult.overflow) {
    logger.debug("curl-runner: response body exceeded cap", {
      url,
      cap: MAX_RESPONSE_BYTES,
    });
    return synthResponse(502, "curl-runner: upstream response exceeded size cap", url);
  }
  const stdoutBytes = stdoutResult.bytes;

  // 8. Map exit codes. curl(1) man page §EXIT CODES.
  if (exitCode !== 0) {
    const status = mapCurlExitCode(exitCode);
    logger.debug("curl-runner: non-zero exit", {
      url,
      exitCode,
      mappedStatus: status,
      stderr: stderrSnippet.slice(0, 512),
    });
    return synthResponse(status, `curl exit ${exitCode}`, url);
  }

  // 9. Parse `--include`'d output into a real Response. With
  //    `-L --max-redirs`, curl emits one header block per hop; we
  //    keep only the final one.
  return parseIncludedOutput(stdoutBytes);
}

/**
 * Map common curl exit codes to HTTP status codes. Defaults to 502
 * (Bad Gateway) for anything we don't recognize so the agent can
 * apply standard upstream-failure handling without leaking internals.
 */
function mapCurlExitCode(exit: number): number {
  switch (exit) {
    case 28:
      // CURLE_OPERATION_TIMEDOUT — `--max-time` exceeded.
      return 504;
    case 6: // CURLE_COULDNT_RESOLVE_HOST
    case 7: // CURLE_COULDNT_CONNECT
    case 35: // CURLE_SSL_CONNECT_ERROR
    case 51: // CURLE_PEER_FAILED_VERIFICATION
    case 60: // CURLE_SSL_CACERT
      return 502;
    default:
      return 502;
  }
}

/**
 * Parse curl `--include` output: one or more
 * `HTTP/x \d{3} …\r\n<headers>\r\n\r\n<body>` blocks. With redirect
 * following, only the final block is the response we care about.
 */
function parseIncludedOutput(bytes: Uint8Array): Response {
  const SEP = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]); // \r\n\r\n
  // Walk forwards splitting on \r\n\r\n. Continue past the final
  // separator so any trailing \r\n\r\n inside a body (rare) is left
  // intact — only the LAST `HTTP/` block counts as headers.
  let lastHeaderEnd = -1;
  let lastHeaderStart = 0;
  for (let i = 0; i <= bytes.length - SEP.length; i++) {
    if (
      bytes[i] === SEP[0] &&
      bytes[i + 1] === SEP[1] &&
      bytes[i + 2] === SEP[2] &&
      bytes[i + 3] === SEP[3]
    ) {
      // Only treat this as a header/body split if the segment
      // starting at `lastHeaderStart` begins with `HTTP/`.
      const slice = bytes.slice(lastHeaderStart, i);
      if (startsWithHttp(slice)) {
        lastHeaderEnd = i + SEP.length;
        lastHeaderStart = lastHeaderEnd;
      } else {
        // Not a header block — body contains \r\n\r\n. Stop scanning;
        // the body extends to the end of the buffer.
        break;
      }
    }
  }

  if (lastHeaderEnd < 0) {
    // Couldn't find any header block — synthesize a 502.
    return synthResponse(502, "curl-runner: malformed response (no headers)", "");
  }

  // The headers we care about are between the second-to-last
  // header-start and `lastHeaderEnd`.
  // Find the start of the FINAL header block by walking back.
  let finalStart = lastHeaderEnd - SEP.length;
  while (finalStart > 0) {
    // Walk back to find either start-of-buffer or the previous \r\n\r\n.
    if (
      bytes[finalStart - 1] === SEP[3] &&
      bytes[finalStart - 2] === SEP[2] &&
      bytes[finalStart - 3] === SEP[1] &&
      bytes[finalStart - 4] === SEP[0]
    ) {
      break;
    }
    finalStart--;
  }

  const headerBlock = new TextDecoder("utf-8").decode(
    bytes.slice(finalStart, lastHeaderEnd - SEP.length),
  );
  const body = bytes.slice(lastHeaderEnd);

  const lines = headerBlock.split(/\r\n/);
  const statusLine = lines.shift() ?? "";
  const statusMatch = /^HTTP\/[\d.]+\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine);
  if (!statusMatch) {
    return synthResponse(502, `curl-runner: malformed status line: ${statusLine}`, "");
  }
  const status = parseInt(statusMatch[1]!, 10);
  const statusText = statusMatch[2] ?? "";

  const headers = new Headers();
  for (const line of lines) {
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    // Content-Length and Transfer-Encoding are controlled by the
    // Response constructor; passing them through verbatim can confuse
    // downstream consumers. Skip them — Bun will set Content-Length
    // from the body Uint8Array.
    const lower = name.toLowerCase();
    if (lower === "content-length" || lower === "transfer-encoding") continue;
    headers.append(name, value);
  }

  return new Response(body, { status, statusText, headers });
}

function startsWithHttp(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x48 && // H
    bytes[1] === 0x54 && // T
    bytes[2] === 0x54 && // T
    bytes[3] === 0x50 && // P
    bytes[4] === 0x2f //   /
  );
}

/**
 * Build a synthetic `Response` for pre-flight failures (invalid URL,
 * header splitting attempt, non-HTTPS, etc.) or for non-zero curl
 * exits. Body is a short opaque message — never includes stderr,
 * never includes the upstream URL beyond the hostname.
 */
function synthResponse(status: number, reason: string, url: string): Response {
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    // url may be empty / malformed
  }
  const body = host ? `${reason} (${host})` : reason;
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** Coerce supported body shapes into a `Uint8Array`. */
function toBytes(body: ArrayBuffer | string | Uint8Array): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(body);
}

/**
 * Drain a `ReadableStream` to a single `Uint8Array`, aborting if the
 * total exceeds `cap` bytes. On overflow the child is killed via
 * `onOverflow` (best-effort) and the partial buffer is discarded —
 * callers synthesize a 502 instead of returning truncated bytes.
 */
async function readAllCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
  onOverflow: () => void,
): Promise<{ bytes: Uint8Array; overflow: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      onOverflow();
      // Drain the rest cheaply so the child's pipe doesn't deadlock.
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
      }
      return { bytes: new Uint8Array(), overflow: true };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes: out, overflow: false };
}

/** Drain up to `cap` bytes from a stream; discard the rest. */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total >= cap) continue;
    const remaining = cap - total;
    const slice = value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(slice);
    total += slice.byteLength;
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(buf);
}

/**
 * Match a resolved URL against a `tlsClientByUrl` table and return
 * the declared client (`"curl"` or `"undici"`). Returns `undefined`
 * when no pattern matches — callers default to undici/Bun fetch.
 *
 * Pattern semantics intentionally reuse `matchesAuthorizedUriSpec`
 * (re-exported from `helpers.ts` as `matchesAuthorizedUri`) so the
 * single-entry-per-segment vs `**` recursion rules are identical to
 * the existing `authorizedUris` matcher.
 */
export function selectTlsClient(
  url: string,
  table: readonly { pattern: string; client: "undici" | "curl" }[] | undefined,
  matcher: (url: string, patterns: string[]) => boolean,
): "undici" | "curl" | undefined {
  if (!table || table.length === 0) return undefined;
  // Iterate in declaration order: the first matching pattern wins.
  // This mirrors how `authorizedUris` is consumed and lets operators
  // express more-specific rules first.
  for (const entry of table) {
    if (matcher(url, [entry.pattern])) {
      return entry.client;
    }
  }
  return undefined;
}
