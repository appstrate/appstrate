// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate api --batch <file>`: many requests from ONE process.
 *
 * A script that shells out once per call pays the CLI's start-up (~0.5 s) every
 * time; the request itself is milliseconds. Here the requests come from a JSON
 * Lines file (`-` = stdin), share the resolved credential and kept-alive
 * connections, and run `--parallel-max` at a time. The line shapes follow the
 * OpenAI / Anthropic batch files (`custom_id`, `method`, `url`, `body`):
 *
 *   in:  {"custom_id": "a", "method": "POST", "url": "/api/x", "headers": {...}, "body": {...}}
 *   out: {"custom_id": "a", "response": {"status_code": 200, "headers": {...}, "body": {...}, "body_encoding": "json"}}
 *        {"custom_id": "b", "error": {"code": 7, "message": "Could not connect: ..."}}
 *
 * Each answer is written as soon as every earlier line's is, so the output
 * follows the input order and an interrupted batch keeps what it already got.
 * Each request goes through the same retry loop as a single call (`--retry`
 * honours `Retry-After`, so a rate-limited batch slows down instead of
 * failing), and a profile's access token that expires mid-batch is refreshed
 * once and the request resent. Every line is validated, and every URL checked
 * against the instance origin, before anything is sent.
 */

import { resolveAuthContext } from "../../lib/api.ts";
import { EXIT_TIMEOUT, classifyNetworkError, labelForExitCode } from "../../lib/http-classify.ts";
import { loginRemedy } from "../../lib/remedy.ts";
import { onShutdown } from "../../lib/shutdown.ts";
import { resolveApiAuth } from "./auth.ts";
import { buildHeaders } from "./headers.ts";
import { isHttpMethod } from "./method.ts";
import { executeWithRetry } from "./retry.ts";
import { skipTlsVerification } from "./tls.ts";
import type { ApiCommandIO, ApiCommandOptions } from "./types.ts";
import { HostMismatchError, buildUrl } from "./url.ts";

const DEFAULT_PARALLEL_MAX = 5;
const EXIT_INTERRUPTED = 130;

interface BatchRequest {
  customId: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type BatchResult =
  | {
      custom_id: string;
      response: {
        status_code: number;
        headers: Record<string, string>;
        body: unknown;
        body_encoding: "json" | "utf8" | "base64";
      };
    }
  | { custom_id: string; error: { code: number; message: string } };

/** Single-request flags that have no meaning for a batch: refused rather than ignored. */
const SINGLE_REQUEST_FLAGS: Array<[keyof ApiCommandOptions, string]> = [
  ["data", "-d"],
  ["dataRaw", "--data-raw"],
  ["dataBinary", "--data-binary"],
  ["dataUrlencode", "--data-urlencode"],
  ["form", "-F"],
  ["query", "-q"],
  ["get", "-G"],
  ["request", "-X"],
  ["include", "-i"],
  ["head", "-I"],
  ["writeOut", "-w"],
  ["uploadFile", "-T"],
  ["connectTimeout", "--connect-timeout"],
];

export async function apiBatchCommand(opts: ApiCommandOptions, io: ApiCommandIO): Promise<void> {
  const writeError = (msg: string): void => {
    if (opts.silent && !opts.showError) return;
    io.stderr.write(msg);
  };
  // Every exit awaits the flush: a batch's output is larger than a pipe holds (#1824).
  const exit = async (code: number): Promise<never> => {
    await io.flush?.();
    return io.exit(code);
  };

  const conflicting = SINGLE_REQUEST_FLAGS.filter(([key]) => {
    const value = opts[key];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false;
  }).map(([, flag]) => flag);
  if (conflicting.length > 0) {
    writeError(`--batch takes each request from its file; remove ${conflicting.join(", ")}\n`);
    return exit(2);
  }

  let input: string;
  try {
    input =
      opts.batch === "-"
        ? await new Response(io.stdinStream?.()).text()
        : await Bun.file(opts.batch!).text();
  } catch (err) {
    writeError(`cannot read ${opts.batch}: ${errorMessage(err)}\n`);
    return exit(2);
  }

  const resolved = await resolveApiAuth(opts);
  if ("error" in resolved) {
    writeError(`${resolved.error}\n`);
    return exit(1);
  }
  const { auth, profileName } = resolved;

  const parsed = parseBatch(input, (path) => buildUrl(auth.instance, path, []));
  if ("error" in parsed) {
    writeError(`${parsed.error}\n`);
    return exit(2);
  }
  const requests = parsed.requests;

  // Shared by every request: a refresh by one is used by all that follow.
  let token = auth.accessToken;
  const headersFor = (r: BatchRequest, bearer: string): Record<string, string> =>
    buildHeaders({
      userHeaders: [...opts.header, ...Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`)],
      token: bearer,
      orgId: auth.orgId,
      spaceId: auth.spaceId,
      userAgent: opts.userAgent,
      referer: opts.referer,
      cookie: opts.cookie,
      range: opts.range,
      compressed: opts.compressed,
    });
  /** A newer token than `sent` (refreshed now or by a parallel request), or undefined. */
  const freshToken = async (sent: string): Promise<string | undefined> => {
    if (profileName === undefined) return undefined; // an API key does not refresh
    try {
      const fresh = (await resolveAuthContext(profileName)).accessToken;
      if (fresh === sent) return undefined;
      token = fresh;
      return fresh;
    } catch {
      return undefined; // the 401 stands, reported below
    }
  };

  // `--max-time` bounds the whole batch: what is not sent by then is reported, not sent.
  const ac = new AbortController();
  io.onSigint?.(() => ac.abort());
  // The shutdown coordinator exits right after its hooks settle, and `process.exit` drops
  // what a pipe has not taken yet (#1824): on Ctrl-C it waits for the batch to account for
  // every line (the unsent ones come back as errors) and for the output to be flushed.
  let batchDone!: () => void;
  const batchSettled = new Promise<void>((resolve) => (batchDone = resolve));
  const unregisterShutdown = onShutdown(async () => {
    ac.abort();
    await batchSettled;
    await io.flush?.();
  });
  const timeout =
    typeof opts.maxTime === "number" && opts.maxTime > 0
      ? setTimeout(
          () => ac.abort(new DOMException("Request timed out", "TimeoutError")),
          opts.maxTime * 1000,
        )
      : undefined;
  const restoreTls = opts.insecure ? skipTlsVerification() : undefined;

  const retryBudgetEnd =
    (opts.retryMaxTime ?? 0) > 0 ? performance.now() + (opts.retryMaxTime ?? 0) * 1000 : Infinity;
  const attempt = (r: BatchRequest, bearer: string): Promise<Response> =>
    executeWithRetry({
      opts,
      // A retry rebuilds the body from these options: the request's own body, nothing else.
      effectiveOpts: { ...opts, dataRaw: r.body },
      url: r.url,
      method: r.method,
      headers: headersFor(r, bearer),
      firstBuild: { body: r.body, usesStdin: false },
      ac,
      io,
      profileName,
      connectTimeoutRef: { current: undefined },
      maxAttempts: 1 + (opts.retry ?? 0),
      retryDelay: opts.retryDelay ?? 1,
      retryBudgetEnd,
    });
  const send = async (r: BatchRequest): Promise<BatchResult> => {
    if (ac.signal.aborted) {
      const code = abortCode(ac.signal);
      return {
        custom_id: r.customId,
        error: { code, message: "not sent: the batch was interrupted" },
      };
    }
    try {
      const sent = token;
      let res = await attempt(r, sent);
      if (res.status === 401) {
        const fresh = await freshToken(sent);
        if (fresh !== undefined) {
          await res.body?.cancel().catch(() => {});
          res = await attempt(r, fresh);
        }
      }
      return {
        custom_id: r.customId,
        response: {
          status_code: res.status,
          headers: headersOf(res),
          ...decodeBody(await res.bytes(), res.headers.get("content-type")),
        },
      };
    } catch (err) {
      const code = ac.signal.aborted ? abortCode(ac.signal) : classifyNetworkError(err);
      return {
        custom_id: r.customId,
        error: { code, message: `${labelForExitCode(code)}: ${errorMessage(err)}` },
      };
    }
  };

  // Lines go out in input order, each as soon as every earlier one is known.
  const sink = opts.output ? Bun.file(opts.output).writer() : undefined;
  const results: Array<BatchResult | undefined> = new Array(requests.length);
  let written = 0;
  const record = (index: number, result: BatchResult): void => {
    results[index] = result;
    while (written < results.length && results[written] !== undefined) {
      const line = `${JSON.stringify(results[written])}\n`;
      // A file sink buffers; its `end()` below awaits the rest.
      if (sink) void sink.write(line);
      else io.stdout.write(line);
      written++;
    }
  };

  let next = 0;
  const parallelMax = Math.min(opts.parallelMax ?? DEFAULT_PARALLEL_MAX, requests.length);
  try {
    await Promise.all(
      Array.from({ length: parallelMax }, async () => {
        while (next < requests.length) {
          const index = next++;
          record(index, await send(requests[index]!));
        }
      }),
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    restoreTls?.();
    await sink?.end();
    batchDone();
    unregisterShutdown();
  }

  const done = results as BatchResult[];
  if (!opts.silent && done.some((r) => "response" in r && r.response.status_code === 401)) {
    io.stderr.write(
      profileName === undefined
        ? "API key rejected — check --api-key / APPSTRATE_API_KEY (revoked, expired, or for another instance)\n"
        : `Session may be expired — run: ${loginRemedy(profileName, auth.instance)}\n`,
    );
  }
  return exit(exitCode(done, opts, writeError));
}

/**
 * Every line valid and on the instance's origin, or the first problem (nothing is sent then).
 * Blank lines are skipped; `custom_id` defaults to the line number, `method` to POST with a
 * body, GET without. A string `body` is sent as is; an object or array is sent as JSON, with
 * `Content-Type: application/json` unless the line or `-H` sets one.
 */
function parseBatch(
  input: string,
  toUrl: (path: string) => string,
): { requests: BatchRequest[] } | { error: string } {
  const requests: BatchRequest[] = [];
  const ids = new Set<string>();
  const lines = input.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.trim();
    if (text === "") continue;
    const where = `line ${i + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { error: `${where}: not valid JSON` };
    }
    if (!isRecord(raw)) return { error: `${where}: expected a JSON object` };
    const { custom_id, method, url, headers, body, ...rest } = raw;
    const unknown = Object.keys(rest);
    if (unknown.length > 0) return { error: `${where}: unknown field "${unknown[0]}"` };
    if (typeof url !== "string" || url === "") return { error: `${where}: "url" is required` };
    if (method !== undefined && (typeof method !== "string" || !isHttpMethod(method))) {
      return { error: `${where}: "method" must be an HTTP method` };
    }
    if (body !== undefined && typeof body !== "string" && !isRecord(body) && !Array.isArray(body)) {
      return { error: `${where}: "body" must be a string, an object or an array` };
    }
    if (
      headers !== undefined &&
      (!isRecord(headers) || Object.values(headers).some((v) => typeof v !== "string"))
    ) {
      return { error: `${where}: "headers" must map names to strings` };
    }
    if (custom_id !== undefined && typeof custom_id !== "string") {
      return { error: `${where}: "custom_id" must be a string` };
    }
    const resolvedMethod = method ? method.toUpperCase() : body === undefined ? "GET" : "POST";
    if (body !== undefined && (resolvedMethod === "GET" || resolvedMethod === "HEAD")) {
      return { error: `${where}: a ${resolvedMethod} request carries no "body"` };
    }
    const customId = custom_id ?? String(i + 1);
    if (ids.has(customId)) return { error: `${where}: duplicate custom_id "${customId}"` };
    ids.add(customId);
    let target: string;
    try {
      target = toUrl(url);
    } catch (err) {
      if (err instanceof HostMismatchError) return { error: `${where}: ${err.message}` };
      throw err;
    }
    const lineHeaders = { ...((headers as Record<string, string> | undefined) ?? {}) };
    if (
      typeof body === "object" &&
      !Object.keys(lineHeaders).some((k) => k.toLowerCase() === "content-type")
    ) {
      lineHeaders["Content-Type"] = "application/json";
    }
    requests.push({
      customId,
      method: resolvedMethod,
      url: target,
      headers: lineHeaders,
      body: typeof body === "object" ? JSON.stringify(body) : body,
    });
  }
  if (requests.length === 0) return { error: "the batch file holds no request" };
  return { requests };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of res.headers) out[k] = v;
  return out;
}

/** A JSON response embedded as JSON, other text as a string, anything else as base64. */
function decodeBody(
  bytes: Uint8Array,
  contentType: string | null,
): { body: unknown; body_encoding: "json" | "utf8" | "base64" } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { body: Buffer.from(bytes).toString("base64"), body_encoding: "base64" };
  }
  if (contentType && /^application\/([\w.+-]+\+)?json\b/i.test(contentType)) {
    try {
      return { body: JSON.parse(text), body_encoding: "json" };
    } catch {
      // Not the JSON it claims to be: hand it back verbatim.
    }
  }
  return { body: text, body_encoding: "utf8" };
}

function abortCode(signal: AbortSignal): number {
  return (signal.reason as { name?: string } | undefined)?.name === "TimeoutError"
    ? EXIT_TIMEOUT
    : EXIT_INTERRUPTED;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The first request that got no response sets the code (curl's: 6, 7, 28, …; 130 on Ctrl-C);
 * else 0, or with `-f` / `--fail-with-body` 22 (a 4xx) / 25 (a 5xx). Every line is written either way.
 */
function exitCode(
  results: BatchResult[],
  opts: ApiCommandOptions,
  writeError: (msg: string) => void,
): number {
  const failed = results.filter((r) => "error" in r);
  if (failed.length > 0) {
    writeError(`${failed.length} of ${results.length} requests got no response\n`);
    return failed[0]!.error.code;
  }
  if (opts.fail || opts.failWithBody) {
    const statuses = results.map((r) => ("response" in r ? r.response.status_code : 0));
    if (statuses.some((s) => s >= 500)) return 25;
    if (statuses.some((s) => s >= 400)) return 22;
  }
  return 0;
}
