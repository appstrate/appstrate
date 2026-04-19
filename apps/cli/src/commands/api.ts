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
 *
 * Implementation layout: this file is the orchestrator. Helpers live
 * alongside in `./api/` — one concern per module (body construction,
 * retry loop, response streaming, verbose trace, write-out formatter,
 * …) so the top-level control flow reads straight through without
 * detours into 100-line helpers.
 */

import { readConfig, resolveProfileName } from "../lib/config.ts";
import { resolveAuthContext, AuthError, ApiError } from "../lib/api.ts";
import { classifyNetworkError, labelForExitCode } from "../lib/http-classify.ts";

import { buildBody, collectGetDataAsQuery } from "./api/body.ts";
import { buildHeaders } from "./api/headers.ts";
import { pickMethod } from "./api/method.ts";
import { executeWithRetry } from "./api/retry.ts";
import { consumeResponseStream, fileChunkSink, streamChunkSink } from "./api/stream.ts";
import { DEFAULT_IO, type ApiCommandIO, type ApiCommandOptions } from "./api/types.ts";
import { HostMismatchError, buildUrl } from "./api/url.ts";
import { type WriteOutMetrics, formatWriteOut, sizeOfBody } from "./api/write-out.ts";

// Public surface consumed by `cli.ts` and the test suite. Re-exported
// here so `import { apiCommand, isHttpMethod, ApiCommandOptions } from
// "./commands/api.ts"` keeps working unchanged after the split.
export { isHttpMethod } from "./api/method.ts";
export { HostMismatchError } from "./api/url.ts";
export type { WriteOutMetrics } from "./api/write-out.ts";
export type { ApiCommandIO, ApiCommandOptions } from "./api/types.ts";

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

  const hasUrlencode = Array.isArray(opts.dataUrlencode) && opts.dataUrlencode.length > 0;

  // P2e — `-T/--upload-file` is mutually exclusive with the other
  // body-producing flags. Reject up front (exit 2) rather than
  // silently letting one of them win.
  if (opts.uploadFile !== undefined) {
    const hasOther =
      opts.data !== undefined ||
      opts.dataRaw !== undefined ||
      opts.dataBinary !== undefined ||
      opts.form.length > 0 ||
      hasUrlencode;
    if (hasOther) {
      writeError(
        "cannot combine -T/--upload-file with -d / --data-raw / --data-binary / --data-urlencode / -F\n",
      );
      return exit(2);
    }
  }

  // `--data-urlencode` treats as its own body mode, mutually exclusive
  // with `-d / --data-raw / --data-binary / -F`. `-T` was already
  // rejected above. Multiple `--data-urlencode` flags accumulate into
  // a `&`-joined body (curl default).
  if (hasUrlencode) {
    const hasOtherBody =
      opts.data !== undefined ||
      opts.dataRaw !== undefined ||
      opts.dataBinary !== undefined ||
      opts.form.length > 0;
    if (hasOtherBody) {
      writeError(
        "cannot combine --data-urlencode with -d / --data-raw / --data-binary / -F (use repeated --data-urlencode for multiple pairs)\n",
      );
      return exit(2);
    }
  }

  // P2c — `-G/--get`: move -d / --data-urlencode values into query,
  // drop body, force GET. curl rejects -G combined with -F (multipart
  // has no sane projection into a query string), we do the same with
  // exit 2.
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
      dataUrlencode: undefined,
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
    appId: auth.appId,
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
    // P3a — retry loop extracted into `executeWithRetry`. It returns
    // the final Response (even for retryable-but-exhausted statuses
    // like a lingering 503 on the last attempt) or throws on a
    // non-retryable network error / abort.
    //
    // `connectTimeoutHandle` is threaded via a `ref` so the retry fn
    // can clear it the moment fetch resolves (further retries should
    // not be subject to the initial connect budget).
    const connectTimeoutRef = { current: connectTimeoutHandle };
    let res: Response;
    try {
      res = await executeWithRetry({
        opts,
        effectiveOpts,
        url,
        method,
        headers,
        firstBuild,
        ac,
        io,
        profileName,
        connectTimeoutRef,
        maxAttempts: 1 + effectiveRetry,
        retryDelay: opts.retryDelay ?? 1,
        retryBudgetEnd:
          (opts.retryMaxTime ?? 0) > 0
            ? performance.now() + (opts.retryMaxTime ?? 0) * 1000
            : Infinity,
      });
    } catch (err) {
      // Sync the local handle with whatever executeWithRetry cleared
      // so cleanup() doesn't double-clear. (Ref pattern avoids a
      // dangling timer if fetch threw after the handle was cleared.)
      connectTimeoutHandle = connectTimeoutRef.current;
      cleanup();
      return handleErr(err);
    }
    connectTimeoutHandle = connectTimeoutRef.current;

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
    } else {
      try {
        const writer =
          opts.output && !failMode ? fileChunkSink(opts.output) : streamChunkSink(bodySink);
        try {
          await consumeResponseStream(res, writer.write, ac.signal, metrics);
        } finally {
          await writer.close();
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

// ─── Local helpers (stay here — only used by apiCommand itself) ─────

function formatStatusLine(res: Response): string {
  // Response.statusText can be empty in modern HTTP/2 servers; fall
  // back to the reason-phrase per RFC 9110 (we just pass through what
  // the runtime gave us — don't lie about HTTP/1.1 vs HTTP/2).
  const text = res.statusText || "";
  return `HTTP/1.1 ${res.status} ${text}\r\n`;
}

function restoreTls(prev: string | undefined): void {
  if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
