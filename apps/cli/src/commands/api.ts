// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate api` — curl-like authenticated HTTP pass-through to the
 * active profile's Appstrate instance.
 *
 * Purpose: let local coding agents (Claude Code, Cursor, Aider, …) make
 * authenticated API calls without ever seeing the raw bearer token. The
 * agent shells out, the CLI injects `Authorization` + `X-Org-Id` from
 * the keyring-backed profile, everything else is a transparent pipe.
 *
 *   METHOD / path are positional.
 *   -H / -F / -q repeatable (Commander's `collect` default).
 *   -d supports literal, @file, and @- (stdin stream).
 *   --fail flips body → stderr and mirrors curl's exit codes.
 *
 * Design rationale vs. `lib/api.ts::apiFetchRaw`:
 *   - apiFetchRaw's reactive 401 retry replays the body — breaks stdin
 *     streams (already consumed). We do proactive refresh only.
 *   - apiFetchRaw injects `Content-Type: application/json` when a body
 *     is present — would corrupt multipart (kills the boundary) and
 *     binary payloads. We never set a default Content-Type.
 *   - apiFetchRaw hard-codes `redirect` and has no TLS-skip hook.
 *
 * Known caveats (documented in --help + README):
 *   - Large stdin uploads: prefer `@file` over `@-` (Bun memory
 *     behavior on piped ReadableStream uploads — oven-sh/bun#25375).
 *   - Response streams: Bun may batch chunks delivered to `res.body`
 *     (oven-sh/bun#13923). We don't add buffering; SSE latency is
 *     runtime-bound.
 *   - `-k` sets NODE_TLS_REJECT_UNAUTHORIZED=0 process-wide for the
 *     duration of the fetch; restored in `finally`. Fine for a one-shot
 *     CLI, don't copy this pattern into a long-running process.
 */

import { readConfig, resolveProfileName } from "../lib/config.ts";
import { resolveAuthContext, AuthError, ApiError } from "../lib/api.ts";
import { CLI_USER_AGENT } from "../lib/version.ts";
import { classifyNetworkError, labelForExitCode } from "../lib/http-classify.ts";

/**
 * HTTP methods we accept as the first positional when the user writes
 * `appstrate api POST /x`. Matches curl's list, minus CONNECT/TRACE
 * which aren't meaningful over fetch().
 */
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export function isHttpMethod(s: string): boolean {
  return HTTP_METHODS.has(s.toUpperCase());
}

/**
 * Thrown when the request target resolves to a different origin than
 * the active profile's Appstrate instance. The whole point of
 * `appstrate api` is to inject a keyring-backed bearer — sending it to
 * a foreign host would leak the token, so we refuse loudly.
 */
export class HostMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `refusing to send bearer to foreign host.\n` +
        `  Expected origin: ${expected}\n` +
        `  Got:             ${actual}\n` +
        `  Hint: use \`curl\` directly for non-Appstrate hosts.`,
    );
    this.name = "HostMismatchError";
  }
}

export interface ApiCommandOptions {
  profile?: string;
  /**
   * HTTP method. Optional — when omitted, inferred from flags:
   * `-I/--head` → HEAD, `-T/--upload-file` → PUT, body present → POST,
   * else GET. An explicit method (whether positional or via `-X`) wins.
   */
  method?: string;
  path: string;
  header: string[];
  form: string[];
  query: string[];
  data?: string;
  dataRaw?: string;
  dataBinary?: string;
  request?: string;
  output?: string;
  include?: boolean;
  head?: boolean;
  silent?: boolean;
  /**
   * `-S, --show-error`: when combined with `-s/--silent`, restores
   * error-message output on stderr while keeping progress / hints
   * suppressed. Matches curl's `-sS` pattern.
   */
  showError?: boolean;
  fail?: boolean;
  location?: boolean;
  insecure?: boolean;
  maxTime?: number;
  /**
   * `-v, --verbose`: trace request + response metadata on stderr
   * (one `>` line per request header, one `<` line per response
   * header, `*` for informational notes). Authorization is always
   * redacted. Verbose output bypasses `-s` (same as curl).
   */
  verbose?: boolean;
  /**
   * `-G, --get`: treat any `-d`/`--data-raw`/`--data-binary` values
   * as query parameters on a GET request (body is cleared). curl
   * semantics — each value is split on `=` and appended. Multipart
   * (`-F`) is incompatible and rejected with exit 2.
   */
  get?: boolean;
}

/**
 * Test seam. Production writes directly to `process.stdout.write` etc.;
 * unit tests inject in-memory sinks to assert on output ordering + byte
 * counts without spawning a subprocess.
 */
export interface ApiCommandIO {
  stdout: { write(chunk: Uint8Array | string): void };
  stderr: { write(chunk: Uint8Array | string): void };
  /** Hook so tests can assert exit codes without terminating the runner. */
  exit: (code: number) => never;
  /** Install SIGINT handler. Tests pass a no-op to skip. */
  onSigint?: (cb: () => void) => void;
  /** Optional stdin override. Defaults to `Bun.stdin.stream()`. */
  stdinStream?: () => ReadableStream<Uint8Array>;
}

const DEFAULT_IO: ApiCommandIO = {
  stdout: {
    write(chunk) {
      if (typeof chunk === "string") process.stdout.write(chunk);
      else process.stdout.write(chunk);
    },
  },
  stderr: {
    write(chunk) {
      if (typeof chunk === "string") process.stderr.write(chunk);
      else process.stderr.write(chunk);
    },
  },
  exit: (code) => process.exit(code),
  onSigint: (cb) => {
    process.once("SIGINT", cb);
  },
  stdinStream: () => Bun.stdin.stream() as unknown as ReadableStream<Uint8Array>,
};

export async function apiCommand(
  opts: ApiCommandOptions,
  io: ApiCommandIO = DEFAULT_IO,
): Promise<void> {
  // Error output gate: curl `-s` silences errors; `-sS` restores
  // them. A bare (no-flag) invocation always prints errors. This
  // helper is applied to every error-class stderr write in the
  // function; UX hints (e.g. the 401 re-login hint) have their own
  // narrower gate (`!opts.silent`, ignoring -S).
  const writeError = (msg: string): void => {
    if (opts.silent && !opts.showError) return;
    io.stderr.write(msg);
  };

  // 1. Resolve auth profile + fresh access token.
  const config = await readConfig();
  const profileName = resolveProfileName(opts.profile, config);

  let auth: Awaited<ReturnType<typeof resolveAuthContext>>;
  try {
    auth = await resolveAuthContext(profileName);
  } catch (err) {
    if (err instanceof AuthError || err instanceof ApiError) {
      writeError(`${err.message}\n`);
      return io.exit(1);
    }
    throw err;
  }

  // P2c — `-G/--get`: move -d values into query, drop body, force GET.
  // curl rejects -G combined with -F (multipart has no sane projection
  // into a query string), we do the same with exit 2.
  let effectiveOpts = opts;
  if (opts.get) {
    if (opts.form.length > 0) {
      writeError("cannot combine -G/--get with -F/--form (multipart)\n");
      return io.exit(2);
    }
    const extraQuery = await collectGetDataAsQuery(opts, io);
    effectiveOpts = {
      ...opts,
      query: [...opts.query, ...extraQuery],
      data: undefined,
      dataRaw: undefined,
      dataBinary: undefined,
    };
  }

  // 2. Build URL + query. Cross-origin target → refuse rather than
  //    leak the bearer (exit 2, curl-aligned for usage errors).
  let url: string;
  try {
    url = buildUrl(auth.instance, effectiveOpts.path, effectiveOpts.query);
  } catch (err) {
    if (err instanceof HostMismatchError) {
      writeError(`${err.message}\n`);
      return io.exit(2);
    }
    throw err;
  }

  // 3. Build headers (user -H last so it can override defaults).
  const headers = buildHeaders({
    userHeaders: effectiveOpts.header,
    token: auth.accessToken,
    orgId: auth.orgId,
  });

  // 4. Build body (mutually exclusive; later modes win).
  const { body, usesStdin } = await buildBody(effectiveOpts, io);

  // 5. Pick method.
  const method = pickMethod(effectiveOpts, Boolean(body));

  // HEAD never sends a body.
  const finalBody = method === "HEAD" ? undefined : body;

  // 6. Abort controller for SIGINT + --max-time.
  const ac = new AbortController();
  let sigintFired = false;
  io.onSigint?.(() => {
    sigintFired = true;
    ac.abort();
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (typeof opts.maxTime === "number" && opts.maxTime > 0) {
    timeoutHandle = setTimeout(() => {
      ac.abort(new DOMException("Request timed out", "TimeoutError"));
    }, opts.maxTime * 1000);
  }

  // 7. TLS skip (process-wide; restored in finally).
  const prevTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (opts.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  // Single source of cleanup — `--max-time` spans fetch() AND the
  // body-stream read loop, so we can't clear the timeout inside a
  // per-phase try/finally. Every exit path (success, error, abort)
  // funnels through `cleanup()` exactly once.
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (opts.insecure) restoreTls(prevTlsReject);
  };

  // Top-level try/finally guarantees cleanup() fires even if a sync
  // throw escapes the output phase (e.g. `io.stdout.write` blowing up
  // on a closed pipe). Without this the TLS env override could leak
  // into any subsequent fetch in the same process. The inner
  // cleanup() calls stay because `io.exit` == `process.exit` in
  // production terminates before finally runs — they handle the
  // normal path; the outer finally handles exceptional ones.
  // cleanup() is idempotent (cleanedUp flag).
  try {
    let res: Response;
    try {
      // `duplex: "half"` is a spec requirement whenever the body is a
      // ReadableStream (whatwg/fetch#1254). Only set when we actually
      // have a streaming body — passing it unconditionally trips
      // Bun/undici's validator on older runtimes.
      //
      // The init object is typed loosely on purpose: our tsconfig doesn't
      // pull in the DOM lib (so `BodyInit` / `RequestInit` aren't
      // globals), but Bun's `fetch` accepts strings, Blobs, FormData,
      // Bun.file, and ReadableStream bodies natively. Silencing the type
      // here keeps the call site readable.
      const init: Record<string, unknown> = {
        method,
        headers,
        body: finalBody,
        signal: ac.signal,
        redirect: opts.location ? "follow" : "manual",
      };
      if (usesStdin) init.duplex = "half";
      // P2a — `-v/--verbose`: trace request on stderr. Always emitted
      // (even with -s), matching curl. Authorization is always redacted.
      if (opts.verbose) writeVerboseRequest(io, profileName, method, url, headers);
      res = await fetch(url, init as Parameters<typeof fetch>[1]);
      if (opts.verbose) writeVerboseResponse(io, res);
    } catch (err) {
      cleanup();
      return handleStreamError(err, ac.signal, sigintFired, io, opts);
    }

    // 8. Soft UX hint on 401 (agents parse exit codes — don't prompt).
    //    Silenced by `-s`; `-sS` doesn't restore it (it's a UX hint,
    //    not an error message — curl's `-S` is narrower than that).
    if (res.status === 401 && !opts.silent) {
      io.stderr.write(`Session may be expired — run: appstrate login --profile ${profileName}\n`);
    }

    // 9. Output.
    //    --fail: non-2xx → body to STDERR, exit 22 (4xx) / 25 (5xx).
    //            2xx     → body to STDOUT, exit 0.
    //    plain:  body to STDOUT regardless of status, exit 0.
    //    -i:     status line + headers on STDOUT before body.
    //    -I:     HEAD — write headers, skip body.
    const writeHeaders = opts.include || opts.head;
    const failMode = Boolean(opts.fail) && !res.ok;
    const bodySink = failMode ? io.stderr : io.stdout;

    if (writeHeaders) {
      io.stdout.write(formatStatusLine(res));
      for (const [k, v] of res.headers) {
        io.stdout.write(`${k}: ${v}\r\n`);
      }
      io.stdout.write("\r\n");
    }

    if (opts.head) {
      // RFC 9110 §9.3.2 — HEAD responses MUST NOT have a body. Bun/undici
      // still delivers an (empty) stream; we deliberately don't touch it.
      cleanup();
      return io.exit(0);
    }

    // Output to file or stdout/stderr.
    if (opts.output && !failMode) {
      try {
        await streamToFile(res, opts.output, ac.signal);
      } catch (err) {
        cleanup();
        return handleStreamError(err, ac.signal, sigintFired, io, opts);
      }
    } else if (res.body) {
      try {
        const reader = res.body.getReader();
        // Race `reader.read()` against an abort promise so SIGINT /
        // --max-time interrupts the stream promptly even when the runtime
        // doesn't auto-propagate the signal into the reader.
        const abortPromise = abortAsRejection(ac.signal);
        while (true) {
          const chunk = await Promise.race([reader.read(), abortPromise]);
          if (chunk.done) break;
          if (chunk.value && chunk.value.byteLength > 0) bodySink.write(chunk.value);
        }
      } catch (err) {
        cleanup();
        return handleStreamError(err, ac.signal, sigintFired, io, opts);
      }
    }

    cleanup();
    // 10. Final exit code.
    if (failMode) {
      return io.exit(res.status >= 500 ? 25 : 22);
    }
    return io.exit(0);
  } finally {
    cleanup();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function buildUrl(instance: string, path: string, queryPairs: string[]): string {
  const instanceOrigin = new URL(instance).origin;
  let u: URL;
  // Detect absolute URLs (scheme://…) and validate the origin before
  // letting `new URL(path, instance)` silently swallow them — without
  // this guard an agent pasting `appstrate api https://evil/x` would
  // send the keyring-backed bearer to a foreign host.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    u = new URL(path);
    if (u.origin !== instanceOrigin) {
      throw new HostMismatchError(instanceOrigin, u.origin);
    }
  } else {
    u = new URL(path, instance);
  }
  for (const raw of queryPairs) {
    const eq = raw.indexOf("=");
    if (eq === -1) {
      u.searchParams.append(raw, "");
    } else {
      u.searchParams.append(raw.slice(0, eq), raw.slice(eq + 1));
    }
  }
  return u.toString();
}

function buildHeaders(args: {
  userHeaders: string[];
  token: string;
  orgId?: string;
}): Record<string, string> {
  // Merge order matters — user headers win.
  const out: Record<string, string> = {
    "User-Agent": CLI_USER_AGENT,
    Authorization: `Bearer ${args.token}`,
  };
  if (args.orgId) out["X-Org-Id"] = args.orgId;
  for (const raw of args.userHeaders) {
    const colon = raw.indexOf(":");
    if (colon === -1) continue; // silently ignore malformed — matches curl
    const name = raw.slice(0, colon).trim();
    const value = raw.slice(colon + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

type BuiltBody = {
  // `unknown` because our tsconfig doesn't expose `BodyInit`; actual
  // runtime shapes: string | Blob | FormData | ReadableStream.
  body?: unknown;
  usesStdin: boolean;
};

async function buildBody(opts: ApiCommandOptions, io: ApiCommandIO): Promise<BuiltBody> {
  // Multipart wins if present.
  if (opts.form.length > 0) {
    const fd = new FormData();
    for (const raw of opts.form) {
      const eq = raw.indexOf("=");
      if (eq === -1) continue;
      const key = raw.slice(0, eq);
      const value = raw.slice(eq + 1);
      // curl -F 'k=@path[;type=mime]'
      if (value.startsWith("@")) {
        const semi = value.indexOf(";type=");
        const pathPart = semi === -1 ? value.slice(1) : value.slice(1, semi);
        const typeOverride = semi === -1 ? undefined : value.slice(semi + ";type=".length);
        const file = Bun.file(pathPart);
        const basename = pathPart.split("/").pop() || pathPart;
        // Bun's multipart serializer reads the filename from the
        // underlying BunFile's absolute path — wrapping in `new File`
        // client-side doesn't override it. To force the basename AND
        // apply any user-supplied MIME, materialize the bytes through
        // a Blob then construct a fresh File whose name is what we
        // want. Trade-off: the whole file gets loaded into memory
        // before upload (streaming is lost). For CLI-scale payloads
        // (package ZIPs, JSON, small binaries) this is fine; if the
        // user is uploading a multi-GB artifact they should stream it
        // via `-d @path` instead of `-F`.
        const bytes = await file.arrayBuffer();
        const type = typeOverride ?? file.type ?? "application/octet-stream";
        fd.append(key, new File([bytes], basename, { type }));
      } else {
        fd.append(key, value);
      }
    }
    return { body: fd, usesStdin: false };
  }

  // --data-raw (never interprets @)
  if (typeof opts.dataRaw === "string") {
    return { body: opts.dataRaw, usesStdin: false };
  }

  // --data-binary (@file or literal; preserves trailing newline)
  if (typeof opts.dataBinary === "string") {
    if (opts.dataBinary.startsWith("@")) {
      const p = opts.dataBinary.slice(1);
      if (p === "-") {
        return { body: io.stdinStream?.(), usesStdin: true };
      }
      return { body: Bun.file(p), usesStdin: false };
    }
    return { body: opts.dataBinary, usesStdin: false };
  }

  // -d / --data
  if (typeof opts.data === "string") {
    if (opts.data.startsWith("@")) {
      const p = opts.data.slice(1);
      if (p === "-") {
        return { body: io.stdinStream?.(), usesStdin: true };
      }
      return { body: Bun.file(p), usesStdin: false };
    }
    // curl -d strips a single trailing newline from literal bodies.
    const stripped = opts.data.endsWith("\n") ? opts.data.slice(0, -1) : opts.data;
    return { body: stripped, usesStdin: false };
  }

  return { body: undefined, usesStdin: false };
}

function pickMethod(opts: ApiCommandOptions, hasBody: boolean): string {
  // Precedence (highest → lowest): -I, -X, positional, -T (PUT),
  // body → POST, else GET. Matches curl's inference.
  if (opts.head) return "HEAD";
  if (opts.request) return opts.request.toUpperCase();
  if (opts.method) return opts.method.toUpperCase();
  return hasBody ? "POST" : "GET";
}

function formatStatusLine(res: Response): string {
  // Response.statusText can be empty in modern HTTP/2 servers; fall
  // back to the reason-phrase per RFC 9110 (we just pass through what
  // the runtime gave us — don't lie about HTTP/1.1 vs HTTP/2).
  const text = res.statusText || "";
  return `HTTP/1.1 ${res.status} ${text}\r\n`;
}

async function streamToFile(res: Response, path: string, signal: AbortSignal): Promise<void> {
  const writer = Bun.file(path).writer();
  try {
    if (res.body) {
      const reader = res.body.getReader();
      const abortPromise = abortAsRejection(signal);
      while (true) {
        const chunk = await Promise.race([reader.read(), abortPromise]);
        if (chunk.done) break;
        if (chunk.value && chunk.value.byteLength > 0) writer.write(chunk.value);
      }
    }
  } finally {
    await writer.end();
  }
}

/**
 * Return a Promise that rejects as soon as `signal` aborts, preserving
 * the abort reason as the rejection's `cause` so downstream classifier
 * logic can tell SIGINT apart from `--max-time` (TimeoutError).
 *
 * Never resolves otherwise — meant to lose `Promise.race` every time
 * the real work completes first.
 */
function abortAsRejection(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(abortError(signal.reason));
      return;
    }
    signal.addEventListener("abort", () => reject(abortError(signal.reason)), { once: true });
  });
}

function abortError(reason: unknown): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError", cause: reason });
}

function handleStreamError(
  err: unknown,
  signal: AbortSignal,
  sigintFired: boolean,
  io: ApiCommandIO,
  opts: ApiCommandOptions,
): never {
  // Same silence gate as the main writeError helper — duplicated here
  // because this fn lives outside the apiCommand closure.
  const writeError = (msg: string): void => {
    if (opts.silent && !opts.showError) return;
    io.stderr.write(msg);
  };
  if (signal.aborted || sigintFired || (err instanceof Error && err.name === "AbortError")) {
    // Distinguish timeout vs SIGINT via the abort reason we set.
    const reason = signal.reason ?? (err as { cause?: unknown })?.cause;
    const isTimeout = reason instanceof Error && reason.name === "TimeoutError" && !sigintFired;
    if (isTimeout) {
      const code = classifyNetworkError(reason);
      writeError(`${labelForExitCode(code)}\n`);
      return io.exit(code);
    }
    return io.exit(130);
  }
  const code = classifyNetworkError(err);
  writeError(`${labelForExitCode(code)}: ${errorMessage(err)}\n`);
  return io.exit(code);
}

function restoreTls(prev: string | undefined): void {
  if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─── P2a — `-v/--verbose` trace ─────────────────────────────────────

/**
 * Curl-style request trace. Always writes to stderr (bypasses `-s` —
 * curl does the same: `-sv` keeps the trace). Authorization is always
 * `[REDACTED]` — the whole point of this CLI is that the agent never
 * sees the raw bearer, and `-v` output is quoted in CI logs, issues,
 * Discord screenshots, etc.
 */
function writeVerboseRequest(
  io: ApiCommandIO,
  profileName: string,
  method: string,
  url: string,
  headers: Record<string, string>,
): void {
  const u = new URL(url);
  io.stderr.write(`* Profile: "${profileName}" → ${u.origin}\n`);
  io.stderr.write(`* Bearer injected from keyring, never exposed to caller\n`);
  io.stderr.write(`> ${method} ${u.pathname}${u.search} HTTP/1.1\r\n`);
  io.stderr.write(`> Host: ${u.host}\r\n`);
  for (const [k, v] of Object.entries(headers)) {
    // Any header named Authorization is redacted, regardless of casing
    // (`-H authorization: …` overrides our injected default but we
    // still hide it — the hash in the value is sensitive).
    const display = k.toLowerCase() === "authorization" ? "Bearer [REDACTED]" : v;
    io.stderr.write(`> ${k}: ${display}\r\n`);
  }
  io.stderr.write(`>\r\n`);
}

function writeVerboseResponse(io: ApiCommandIO, res: Response): void {
  io.stderr.write(`< HTTP/1.1 ${res.status} ${res.statusText || ""}\r\n`);
  for (const [k, v] of res.headers) {
    io.stderr.write(`< ${k}: ${v}\r\n`);
  }
  io.stderr.write(`<\r\n`);
}

// ─── P2c — `-G/--get` data → query transformation ───────────────────

/**
 * Consume any body-data flags and project them into query-string
 * pairs. curl's `-G` semantics: each value is treated as an
 * already-encoded `k=v[&k=v]*` fragment. We split on `&` and pass
 * each pair through `-q`-style parsing in `buildUrl` (which uses
 * URL.searchParams for proper encoding of any embedded whitespace).
 */
async function collectGetDataAsQuery(opts: ApiCommandOptions, io: ApiCommandIO): Promise<string[]> {
  const values: string[] = [];
  const pushStr = (raw: string): void => {
    const stripped = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    values.push(stripped);
  };
  const readFromRef = async (ref: string): Promise<string> => {
    if (ref === "-") {
      const reader = io.stdinStream?.().getReader();
      if (!reader) return "";
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
    }
    return Bun.file(ref).text();
  };
  if (typeof opts.data === "string") {
    if (opts.data.startsWith("@")) pushStr(await readFromRef(opts.data.slice(1)));
    else pushStr(opts.data);
  }
  if (typeof opts.dataRaw === "string") values.push(opts.dataRaw);
  if (typeof opts.dataBinary === "string") {
    if (opts.dataBinary.startsWith("@")) values.push(await readFromRef(opts.dataBinary.slice(1)));
    else values.push(opts.dataBinary);
  }
  // Split each value on `&` so `-d 'k=v&k2=v2'` produces two query pairs.
  return values.flatMap((v) => v.split("&")).filter(Boolean);
}
