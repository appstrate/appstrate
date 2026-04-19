// SPDX-License-Identifier: Apache-2.0

import { buildBody, type BuiltBody } from "./body.ts";
import type { ApiCommandOptions, ApiCommandIO } from "./types.ts";
import { writeVerboseRequest, writeVerboseResponse } from "./verbose.ts";

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

export interface RetryContext {
  opts: ApiCommandOptions;
  effectiveOpts: ApiCommandOptions;
  url: string;
  method: string;
  headers: Record<string, string>;
  firstBuild: BuiltBody;
  ac: AbortController;
  io: ApiCommandIO;
  profileName: string;
  connectTimeoutRef: { current: ReturnType<typeof setTimeout> | undefined };
  maxAttempts: number;
  retryDelay: number;
  retryBudgetEnd: number;
}

/**
 * Drive the fetch + retry loop. Each attempt rebuilds the body (the
 * first reuses `firstBuild`); on a retryable HTTP status or network
 * error we sleep and retry up to `maxAttempts - 1` extra times,
 * bounded by `retryBudgetEnd`. Abort (SIGINT / --max-time /
 * --connect-timeout) short-circuits immediately.
 *
 * Returns whichever Response the final attempt produced — even if
 * that's a retryable status with attempts exhausted (caller decides
 * what to do with it, e.g. `--fail` would still map 503 → exit 25).
 * Throws the final network error when all retries have been used or
 * the budget is blown.
 */
export async function executeWithRetry(ctx: RetryContext): Promise<Response> {
  const {
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
    maxAttempts,
    retryDelay,
    retryBudgetEnd,
  } = ctx;

  for (let attempt = 1; ; attempt++) {
    const { body: attemptBody, usesStdin: attemptStdin } =
      attempt === 1 ? firstBuild : await buildBody(effectiveOpts, io);
    const finalBody = method === "HEAD" ? undefined : attemptBody;
    const init: Record<string, unknown> = {
      method,
      headers,
      body: finalBody,
      signal: ac.signal,
      redirect: opts.location ? "follow" : "manual",
    };
    if (attemptStdin) init.duplex = "half";
    if (opts.verbose) writeVerboseRequest(io, profileName, method, url, headers);

    let res: Response;
    try {
      res = await fetch(url, init as Parameters<typeof fetch>[1]);
    } catch (err) {
      if (ac.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw err;
      }
      if (attempt < maxAttempts && isRetryableError(err, opts.retryConnrefused === true)) {
        const delayMs = retryDelay * 1000 * Math.pow(2, attempt - 1);
        if (performance.now() + delayMs > retryBudgetEnd) throw err;
        if (opts.verbose) io.stderr.write(`* retry after ${delayMs}ms (network error)\n`);
        await sleepWithAbort(delayMs, ac.signal);
        continue;
      }
      throw err;
    }

    // Response headers arrived — clear the connect-timeout timer.
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = undefined;
    }
    if (opts.verbose) writeVerboseResponse(io, res);

    if (attempt < maxAttempts && isRetryableStatus(res.status)) {
      const delayMs = computeRetryDelayMs(res, retryDelay, attempt);
      if (performance.now() + delayMs > retryBudgetEnd) return res;
      if (opts.verbose) io.stderr.write(`* retry after ${delayMs}ms (status ${res.status})\n`);
      // Drain so the connection can be reused before sleeping.
      try {
        await res.body?.cancel();
      } catch {
        /* ignore — body may already be consumed */
      }
      await sleepWithAbort(delayMs, ac.signal);
      continue;
    }

    return res;
  }
}
