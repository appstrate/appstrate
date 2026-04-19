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
  /**
   * `-w, --write-out <fmt>`: after the body, write a curl-style format
   * string with `%{variable}` interpolation to stdout. Supported vars
   * documented on `formatWriteOut`. Unknown vars are passed through
   * verbatim (matches curl). Escape sequences `\n \r \t` are expanded
   * in the format string itself so shells that don't pre-interpolate
   * (zsh `echo` vs bash) produce the same output.
   */
  writeOut?: string;
  /**
   * `--connect-timeout <sec>`: abort if fetch() doesn't resolve its
   * response-headers Promise in N seconds. Approximates curl's
   * "time spent in DNS + TCP + TLS handshake" — Bun fetch doesn't
   * expose separate phases, but timing out before the server starts
   * streaming is the same user-visible behavior. Exit 28.
   */
  connectTimeout?: number;
  /**
   * `-T, --upload-file <path-or-->`: send the contents of a file as
   * the request body with default method PUT (curl semantics). `-T -`
   * streams stdin. Mutually exclusive with `-d / -F / --data-raw /
   * --data-binary` (exit 2).
   */
  uploadFile?: string;
  /**
   * `--retry <n>`: retry on transient HTTP codes (408, 429, 500, 502,
   * 503, 504) and DNS / timeout errors. Exponential backoff starting
   * at `retryDelay` seconds. ECONNREFUSED is terminal unless
   * `retryConnrefused` is set (curl semantics). Incompatible with
   * stdin body (`-d @-` / `-T -`) — we can't replay a consumed
   * stream; the CLI emits a warning and disables retry in that case.
   */
  retry?: number;
  /** `--retry-max-time <sec>`: total wall-clock budget for retries. */
  retryMaxTime?: number;
  /** `--retry-delay <sec>`: base backoff (defaults to 1s; doubled each attempt). */
  retryDelay?: number;
  /** `--retry-connrefused`: treat ECONNREFUSED as retryable too. */
  retryConnrefused?: boolean;
  /**
   * `--compressed`: advertise Accept-Encoding gzip/deflate/br. Bun's
   * fetch transparently decompresses the response body.
   */
  compressed?: boolean;
  /**
   * `-r, --range <spec>`: send a `Range: bytes=<spec>` header. Passes
   * through verbatim (e.g. `0-1023`, `-500`, `1000-`).
   */
  range?: string;
  /**
   * `-A, --user-agent <ua>`: override the default User-Agent. An
   * explicit `-H User-Agent: …` still wins (merge order).
   */
  userAgent?: string;
  /**
   * `-e, --referer <url>`: set the Referer request header. Shortcut
   * for `-H "Referer: <url>"`. curl's `;auto` variant is not supported.
   */
  referer?: string;
  /**
   * `-b, --cookie <data>`: literal cookie string `"k=v; k2=v2"`. File
   * paths (curl cookie jars) are NOT supported — the CLI rejects
   * anything that looks like a path with exit 2.
   */
  cookie?: string;
  /**
   * `--fail-with-body`: curl 7.76+ shape. When combined with a non-2xx,
   * exit 22/25 like `-f` but keep the response body going to stdout
   * (instead of suppressing it). Agents that need the error payload
   * for logging use this.
   */
  failWithBody?: boolean;
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

  // P2b — `-w/--write-out` metrics are allocated up-front so even the
  // pre-fetch early-exit paths (auth error, host mismatch, -G+-F)
  // can emit the format string with zeroed timings / sizes, matching
  // curl's behavior on connect failure.
  const metrics: WriteOutMetrics = {
    tStart: performance.now(),
    tFirstByte: null,
    tEnd: null,
    sizeDownload: 0,
    sizeUpload: null, // filled in after body is built
    httpCode: 0,
    urlEffective: opts.path,
    numRedirects: 0,
    responseHeaders: {},
    exitCode: 0,
  };
  const emitWriteOut = (code: number): void => {
    if (!opts.writeOut) return;
    metrics.exitCode = code;
    metrics.tEnd ??= performance.now();
    io.stdout.write(formatWriteOut(opts.writeOut, metrics));
  };
  const exit = (code: number): never => {
    emitWriteOut(code);
    return io.exit(code);
  };

  // AbortController wires together SIGINT, `--max-time`, and
  // `--connect-timeout`. Declared up-front (before `handleErr`) so the
  // closure below can reference `ac` / `sigintFired` without hitting a
  // TDZ. Timers are armed later, right before the retry loop, so they
  // don't count keyring access / token refresh against the budget.
  const ac = new AbortController();
  let sigintFired = false;
  io.onSigint?.(() => {
    sigintFired = true;
    ac.abort();
  });

  // Single source for stream/network error classification. Replaces
  // the former free-standing `handleStreamError` — inlined as a
  // closure so it can funnel through `exit(code)` and emit `-w`
  // output with the right exit code.
  const handleErr = (err: unknown): never => {
    if (ac.signal.aborted || sigintFired || (err instanceof Error && err.name === "AbortError")) {
      const reason = ac.signal.reason ?? (err as { cause?: unknown })?.cause;
      const isTimeout = reason instanceof Error && reason.name === "TimeoutError" && !sigintFired;
      if (isTimeout) {
        const code = classifyNetworkError(reason);
        writeError(`${labelForExitCode(code)}\n`);
        return exit(code);
      }
      return exit(130);
    }
    const code = classifyNetworkError(err);
    writeError(`${labelForExitCode(code)}: ${errorMessage(err)}\n`);
    return exit(code);
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
      return exit(1);
    }
    throw err;
  }

  // P2e — `-T/--upload-file` is mutually exclusive with the other
  // body-producing flags. Reject up front (exit 2) rather than
  // silently letting one of them win.
  if (opts.uploadFile !== undefined) {
    const hasOther =
      opts.data !== undefined ||
      opts.dataRaw !== undefined ||
      opts.dataBinary !== undefined ||
      opts.form.length > 0;
    if (hasOther) {
      writeError("cannot combine -T/--upload-file with -d / --data-raw / --data-binary / -F\n");
      return exit(2);
    }
  }

  // P2c — `-G/--get`: move -d values into query, drop body, force GET.
  // curl rejects -G combined with -F (multipart has no sane projection
  // into a query string), we do the same with exit 2.
  let effectiveOpts = opts;
  if (opts.get) {
    if (opts.form.length > 0) {
      writeError("cannot combine -G/--get with -F/--form (multipart)\n");
      return exit(2);
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
      return exit(2);
    }
    throw err;
  }

  // Reject cookie-jar syntax (curl `-b file.txt`). The heuristic is
  // "starts with `./` / `/` / `~/`" — common path prefixes. We could
  // stat the path to be certain, but a false positive (user has a
  // literal cookie starting with `/`) is better than quietly reading
  // a random file and putting its contents in the Cookie header.
  if (opts.cookie && /^(\.?\.?\/|~)/.test(opts.cookie)) {
    writeError(
      "cookie jars are not supported (curl `-b file.txt`). Use a literal `k=v` string or set `-H Cookie: ...`.\n",
    );
    return exit(2);
  }

  // 3. Build headers (user -H last so it can override defaults).
  const headers = buildHeaders({
    userHeaders: effectiveOpts.header,
    token: auth.accessToken,
    orgId: auth.orgId,
    userAgent: opts.userAgent,
    referer: opts.referer,
    cookie: opts.cookie,
    range: opts.range,
    compressed: opts.compressed,
  });

  // 4. Build body (mutually exclusive; later modes win).
  //    First build happens here so we can detect stream-backed bodies
  //    and decide whether --retry is safe. On retry, we rebuild to
  //    materialize a fresh FormData / BunFile handle.
  const firstBuild = await buildBody(effectiveOpts, io);
  const originalRetry = opts.retry ?? 0;
  let effectiveRetry = originalRetry;
  if (originalRetry > 0 && firstBuild.usesStdin) {
    writeError("--retry disabled: body is consumed from stdin and cannot be replayed.\n");
    effectiveRetry = 0;
  }

  // 5. Pick method.
  const method = pickMethod(effectiveOpts, Boolean(firstBuild.body));

  // Finalize the sizeUpload metric now that the body shape is known.
  metrics.sizeUpload = sizeOfBody(method === "HEAD" ? undefined : firstBuild.body);
  metrics.urlEffective = url;

  // 6. Arm timers against the shared AbortController. SIGINT wiring
  //    already happened at the top of the function; timers start now
  //    so auth/keyring time doesn't eat into the user's budget.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (typeof opts.maxTime === "number" && opts.maxTime > 0) {
    timeoutHandle = setTimeout(() => {
      ac.abort(new DOMException("Request timed out", "TimeoutError"));
    }, opts.maxTime * 1000);
  }
  // P2d — `--connect-timeout`: separate timer that aborts if fetch()
  // hasn't resolved (i.e. response headers haven't arrived) within N
  // seconds. Cleared as soon as the response starts, so body streaming
  // is bounded only by --max-time. curl treats this as exit 28, same
  // TimeoutError flavor.
  let connectTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (typeof opts.connectTimeout === "number" && opts.connectTimeout > 0) {
    connectTimeoutHandle = setTimeout(() => {
      ac.abort(new DOMException("Connect timed out", "TimeoutError"));
    }, opts.connectTimeout * 1000);
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
    if (connectTimeoutHandle) clearTimeout(connectTimeoutHandle);
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
    // P3a — retry loop. Each attempt rebuilds the body (first attempt
    // reuses `firstBuild`); on retryable status / network error we
    // sleep and retry up to `effectiveRetry` times, bounded by
    // `--retry-max-time`. AbortSignal (SIGINT, --max-time) short-
    // circuits the loop.
    const retryDelay = opts.retryDelay ?? 1;
    const retryMaxTimeMs = (opts.retryMaxTime ?? 0) * 1000;
    const retryBudgetEnd = retryMaxTimeMs > 0 ? performance.now() + retryMaxTimeMs : Infinity;
    const maxAttempts = 1 + effectiveRetry;
    let res!: Response;
    let attempt = 0;
    while (true) {
      attempt++;
      const { body: attemptBody, usesStdin: attemptStdin } =
        attempt === 1 ? firstBuild : await buildBody(effectiveOpts, io);
      const attemptFinalBody = method === "HEAD" ? undefined : attemptBody;
      try {
        const init: Record<string, unknown> = {
          method,
          headers,
          body: attemptFinalBody,
          signal: ac.signal,
          redirect: opts.location ? "follow" : "manual",
        };
        if (attemptStdin) init.duplex = "half";
        if (opts.verbose) writeVerboseRequest(io, profileName, method, url, headers);
        res = await fetch(url, init as Parameters<typeof fetch>[1]);
        if (connectTimeoutHandle) {
          clearTimeout(connectTimeoutHandle);
          connectTimeoutHandle = undefined;
        }
        if (opts.verbose) writeVerboseResponse(io, res);
        if (attempt < maxAttempts && isRetryableStatus(res.status)) {
          const delayMs = computeRetryDelayMs(res, retryDelay, attempt);
          if (performance.now() + delayMs > retryBudgetEnd) break;
          if (opts.verbose) io.stderr.write(`* retry after ${delayMs}ms (status ${res.status})\n`);
          // Drain the response body so the connection can be reused.
          try {
            await res.body?.cancel();
          } catch {
            /* ignore — response may already be consumed */
          }
          await sleepWithAbort(delayMs, ac.signal);
          continue;
        }
        break;
      } catch (err) {
        if (ac.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          cleanup();
          return handleErr(err);
        }
        if (attempt < maxAttempts && isRetryableError(err, opts.retryConnrefused === true)) {
          const delayMs = retryDelay * 1000 * Math.pow(2, attempt - 1);
          if (performance.now() + delayMs > retryBudgetEnd) {
            cleanup();
            return handleErr(err);
          }
          if (opts.verbose) io.stderr.write(`* retry after ${delayMs}ms (network error)\n`);
          await sleepWithAbort(delayMs, ac.signal);
          continue;
        }
        cleanup();
        return handleErr(err);
      }
    }

    // P2b — capture response-level metrics for -w
    metrics.httpCode = res.status;
    metrics.urlEffective = res.url || url;
    metrics.numRedirects = res.redirected ? 1 : 0;
    for (const [k, v] of res.headers) metrics.responseHeaders[k] = v;

    // 8. Soft UX hint on 401 (agents parse exit codes — don't prompt).
    //    Silenced by `-s`; `-sS` doesn't restore it (it's a UX hint,
    //    not an error message — curl's `-S` is narrower than that).
    if (res.status === 401 && !opts.silent) {
      io.stderr.write(`Session may be expired — run: appstrate login --profile ${profileName}\n`);
    }

    // 9. Output.
    //    -f,  --fail (curl-aligned): non-2xx → body suppressed,
    //         exit 22 (4xx) / 25 (5xx).
    //    --fail-with-body: non-2xx → body still on stdout, exit 22/25.
    //    default: body on stdout regardless of status, exit 0.
    //    -i: status line + headers on stdout before body.
    //    -I: HEAD — headers only, no body.
    const writeHeaders = opts.include || opts.head;
    const failStrict = Boolean(opts.fail) && !res.ok;
    const failWithBody = Boolean(opts.failWithBody) && !res.ok;
    const failMode = failStrict || failWithBody;
    // `-f` (strict) suppresses the body entirely (curl behavior).
    // `--fail-with-body` keeps body on stdout for logging.
    // Without either: body always to stdout.
    const suppressBody = failStrict;
    const bodySink = io.stdout;

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
      return exit(0);
    }

    // Output to file or stdout. Strict -f suppresses body entirely.
    if (suppressBody) {
      // curl's `-f` discards the body without reading it, and reports
      // `%{size_download} = 0`. We match: `cancel()` releases the
      // underlying connection without pulling bytes, so `sizeDownload`
      // stays at its initial 0 (accurate — we did not download the
      // body). Use `--fail-with-body` if you need the payload.
      try {
        await res.body?.cancel();
      } catch {
        /* ignore — body may already be consumed */
      }
    } else if (opts.output && !failMode) {
      try {
        await streamToFile(res, opts.output, ac.signal, metrics);
      } catch (err) {
        cleanup();
        return handleErr(err);
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
          if (chunk.value && chunk.value.byteLength > 0) {
            if (metrics.tFirstByte === null) metrics.tFirstByte = performance.now();
            metrics.sizeDownload += chunk.value.byteLength;
            bodySink.write(chunk.value);
          }
        }
      } catch (err) {
        cleanup();
        return handleErr(err);
      }
    }

    cleanup();
    // 10. Final exit code.
    const code = failMode ? (res.status >= 500 ? 25 : 22) : 0;
    return exit(code);
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
  userAgent?: string;
  referer?: string;
  cookie?: string;
  range?: string;
  compressed?: boolean;
}): Record<string, string> {
  // Merge order matters — defaults first, shortcut flags next (they
  // override defaults), user `-H` headers last (override everything).
  const out: Record<string, string> = {
    "User-Agent": args.userAgent ?? CLI_USER_AGENT,
    Authorization: `Bearer ${args.token}`,
  };
  if (args.orgId) out["X-Org-Id"] = args.orgId;
  if (args.compressed) out["Accept-Encoding"] = "gzip, deflate, br";
  if (args.range) out["Range"] = `bytes=${args.range}`;
  if (args.referer) out["Referer"] = args.referer;
  if (args.cookie) out["Cookie"] = args.cookie;
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
  // P2e — `-T path` uploads the raw file contents as the body. `-T -`
  // streams stdin. Mutual exclusion with -d/-F is enforced at the
  // apiCommand level before we get here.
  if (opts.uploadFile !== undefined) {
    if (opts.uploadFile === "-") {
      return { body: io.stdinStream?.(), usesStdin: true };
    }
    return { body: Bun.file(opts.uploadFile), usesStdin: false };
  }

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
  if (opts.uploadFile !== undefined) return "PUT";
  return hasBody ? "POST" : "GET";
}

function formatStatusLine(res: Response): string {
  // Response.statusText can be empty in modern HTTP/2 servers; fall
  // back to the reason-phrase per RFC 9110 (we just pass through what
  // the runtime gave us — don't lie about HTTP/1.1 vs HTTP/2).
  const text = res.statusText || "";
  return `HTTP/1.1 ${res.status} ${text}\r\n`;
}

async function streamToFile(
  res: Response,
  path: string,
  signal: AbortSignal,
  metrics?: WriteOutMetrics,
): Promise<void> {
  const writer = Bun.file(path).writer();
  try {
    if (res.body) {
      const reader = res.body.getReader();
      const abortPromise = abortAsRejection(signal);
      while (true) {
        const chunk = await Promise.race([reader.read(), abortPromise]);
        if (chunk.done) break;
        if (chunk.value && chunk.value.byteLength > 0) {
          if (metrics) {
            if (metrics.tFirstByte === null) metrics.tFirstByte = performance.now();
            metrics.sizeDownload += chunk.value.byteLength;
          }
          writer.write(chunk.value);
        }
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

// ─── P3a — retry helpers ────────────────────────────────────────────

/**
 * HTTP status codes considered transient and therefore retryable.
 * Matches curl's default set (408 Request Timeout, 429 Too Many
 * Requests, plus 5xx gateway/service errors).
 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/**
 * Classify a fetch-time error as retryable. DNS resolution failures
 * and timeouts always qualify; connection-refused is opt-in via
 * `--retry-connrefused` (curl semantics — by default, refused means
 * the service is genuinely down and retries won't help).
 */
function isRetryableError(err: unknown, retryConnrefused: boolean): boolean {
  if (!err || typeof err !== "object") return false;
  // Walk cause chain up to 3 levels (Bun wraps system errors).
  let current: unknown = err;
  for (let i = 0; i < 3 && current && typeof current === "object"; i++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      if (code === "ENOTFOUND" || code === "EAI_AGAIN") return true;
      if (code === "ECONNREFUSED") return retryConnrefused;
    }
    const name = (current as { name?: unknown }).name;
    if (name === "TimeoutError") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Compute the next retry delay in milliseconds. Honors the server's
 * `Retry-After` header when plausible (429 / 503), otherwise falls
 * back to exponential backoff on `baseSeconds`.
 *
 * `Retry-After` supports two syntaxes in the wild: delta-seconds
 * (RFC 9110 §10.2.3) and HTTP-date. We accept the first; HTTP-date
 * is parsed best-effort and ignored if it's in the past or invalid.
 */
function computeRetryDelayMs(res: Response, baseSeconds: number, attempt: number): number {
  const hdr = res.headers.get("retry-after");
  if (hdr) {
    const asNumber = Number(hdr);
    if (Number.isFinite(asNumber) && asNumber >= 0 && asNumber < 3600) {
      return asNumber * 1000;
    }
    const asDate = Date.parse(hdr);
    if (Number.isFinite(asDate)) {
      const delta = asDate - Date.now();
      if (delta > 0 && delta < 3600 * 1000) return delta;
    }
  }
  return baseSeconds * 1000 * Math.pow(2, attempt - 1);
}

/**
 * Sleep that resolves early on abort. Used between retry attempts so
 * SIGINT / --max-time interrupts a long backoff without waiting for
 * the timer to expire.
 */
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal.aborted) {
      clearTimeout(t);
      resolve();
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

// ─── P2b — `-w/--write-out` ─────────────────────────────────────────

/**
 * Subset of curl's `-w` metrics that we can derive from Web fetch.
 *
 *  tStart / tFirstByte / tEnd are `performance.now()` timestamps
 *    (milliseconds since CLI launch). Converted to seconds in the
 *    formatter — curl emits seconds with 6-decimal precision.
 *  sizeUpload is `null` when the body shape doesn't expose a length
 *    (FormData, ReadableStream) — we render that as `0` rather than
 *    making up a number.
 */
export interface WriteOutMetrics {
  tStart: number;
  tFirstByte: number | null;
  tEnd: number | null;
  sizeDownload: number;
  sizeUpload: number | null;
  httpCode: number;
  urlEffective: string;
  numRedirects: number;
  responseHeaders: Record<string, string>;
  exitCode: number;
}

/**
 * Best-effort synchronous size of a request body. Matches the
 * shapes `buildBody()` produces:
 *   - `undefined` → 0
 *   - `string`    → UTF-8 byte length
 *   - Bun.file(...) handle → `.size` getter
 *   - FormData / ReadableStream → unknown (null)
 */
function sizeOfBody(body: unknown): number | null {
  if (body === undefined || body === null) return 0;
  if (typeof body === "string") return new TextEncoder().encode(body).length;
  if (body && typeof body === "object" && "size" in body) {
    const s = (body as { size: unknown }).size;
    if (typeof s === "number") return s;
  }
  return null;
}

/**
 * Expand a curl `-w` format string. Supported variables:
 *   %{http_code}            Final response status (0 on connect failure)
 *   %{http_version}         Hardcoded "1.1" — fetch doesn't expose the real version
 *   %{size_download}        Body bytes received
 *   %{size_upload}          Body bytes sent (0 when unknown)
 *   %{time_total}           Total request time, seconds, 6 decimals
 *   %{time_starttransfer}   Time until first response byte, seconds
 *   %{url_effective}        Final URL (after redirects with `-L`)
 *   %{num_redirects}        1 if -L followed a redirect, else 0
 *   %{header_json}          Response headers as a JSON object
 *   %{exitcode}             Our process exit code (0 on success)
 *
 * Escape sequences `\n \r \t` are expanded in the format string
 * itself — agents that embed `-w "%{http_code}\n"` should get a
 * trailing newline regardless of shell quoting rules.
 * Unknown variables are passed through verbatim (matches curl).
 */
function formatWriteOut(fmt: string, m: WriteOutMetrics): string {
  const expanded = fmt.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
  const secondsSince = (t: number | null): string => {
    if (t === null) return "0.000000";
    return ((t - m.tStart) / 1000).toFixed(6);
  };
  return expanded.replace(/%\{([a-z_]+)\}/g, (match, name: string) => {
    switch (name) {
      case "http_code":
        return String(m.httpCode);
      case "http_version":
        return "1.1";
      case "size_download":
        return String(m.sizeDownload);
      case "size_upload":
        return String(m.sizeUpload ?? 0);
      case "time_total":
        return secondsSince(m.tEnd);
      case "time_starttransfer":
        return secondsSince(m.tFirstByte);
      case "url_effective":
        return m.urlEffective;
      case "num_redirects":
        return String(m.numRedirects);
      case "header_json":
        return JSON.stringify(m.responseHeaders);
      case "exitcode":
        return String(m.exitCode);
      default:
        return match;
    }
  });
}
