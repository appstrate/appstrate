// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate api --batch <file>`: many requests from ONE process.
 *
 * A script that shells out once per call pays the CLI's start-up (~0.5 s) every
 * time; the request itself is milliseconds. Here the requests come from a JSON
 * Lines file (`-` = stdin), share the resolved credential and kept-alive
 * connections, run `--parallel` at a time, and each answer is one JSON line,
 * written in input order:
 *
 *   in:  {"id": "a", "method": "GET", "path": "/api/x", "headers": {...}, "body": "..."}
 *   out: {"id": "a", "status": 200, "headers": {...}, "body": "...", "body_encoding": "utf8"}
 *        {"id": "b", "error": "Could not resolve host: ..."}
 *
 * Each request goes through the same retry loop as a single call (`--retry`
 * honours `Retry-After`, so a rate-limited batch slows down instead of failing).
 * Every line is validated, and every URL checked against the instance origin,
 * before anything is sent.
 */

import { classifyNetworkError, labelForExitCode } from "../../lib/http-classify.ts";
import { loginRemedy } from "../../lib/remedy.ts";
import { resolveApiAuth } from "./auth.ts";
import { buildHeaders } from "./headers.ts";
import { isHttpMethod } from "./method.ts";
import { executeWithRetry } from "./retry.ts";
import type { ApiCommandIO, ApiCommandOptions } from "./types.ts";
import { HostMismatchError, buildUrl } from "./url.ts";

const DEFAULT_PARALLEL = 5;

interface BatchRequest {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type BatchResult =
  | {
      id: string;
      status: number;
      headers: Record<string, string>;
      body: string;
      body_encoding: "utf8" | "base64";
    }
  | { id: string; error: string };

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

  const conflicting = SINGLE_REQUEST_FLAGS.filter(([key]) => {
    const value = opts[key];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false;
  }).map(([, flag]) => flag);
  if (conflicting.length > 0) {
    writeError(`--batch takes each request from its file; remove ${conflicting.join(", ")}\n`);
    return io.exit(2);
  }

  let input: string;
  try {
    input =
      opts.batch === "-"
        ? await new Response(io.stdinStream?.()).text()
        : await Bun.file(opts.batch!).text();
  } catch (err) {
    writeError(`cannot read ${opts.batch}: ${err instanceof Error ? err.message : String(err)}\n`);
    return io.exit(2);
  }

  const resolved = await resolveApiAuth(opts);
  if ("error" in resolved) {
    writeError(`${resolved.error}\n`);
    return io.exit(1);
  }
  const { auth, profileName } = resolved;

  const parsed = parseBatch(input, (path) => buildUrl(auth.instance, path, []));
  if ("error" in parsed) {
    writeError(`${parsed.error}\n`);
    return io.exit(2);
  }
  const requests = parsed.requests.map((r) => ({
    ...r,
    headers: buildHeaders({
      userHeaders: [...opts.header, ...Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`)],
      token: auth.accessToken,
      orgId: auth.orgId,
      spaceId: auth.spaceId,
      userAgent: opts.userAgent,
      referer: opts.referer,
      cookie: opts.cookie,
      range: opts.range,
      compressed: opts.compressed,
    }),
  }));

  const ac = new AbortController();
  io.onSigint?.(() => ac.abort());
  const timeout =
    typeof opts.maxTime === "number" && opts.maxTime > 0
      ? setTimeout(
          () => ac.abort(new DOMException("Request timed out", "TimeoutError")),
          opts.maxTime * 1000,
        )
      : undefined;
  const prevTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (opts.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const retryBudgetEnd =
    (opts.retryMaxTime ?? 0) > 0 ? performance.now() + (opts.retryMaxTime ?? 0) * 1000 : Infinity;
  const send = async (r: BatchRequest): Promise<BatchResult> => {
    if (ac.signal.aborted) return { id: r.id, error: "not sent: the batch was interrupted" };
    try {
      const res = await executeWithRetry({
        opts,
        // A retry rebuilds the body from these options: the request's own body, nothing else.
        effectiveOpts: { ...opts, dataRaw: r.body },
        url: r.url,
        method: r.method,
        headers: r.headers,
        firstBuild: { body: r.body, usesStdin: false },
        ac,
        io,
        profileName,
        connectTimeoutRef: { current: undefined },
        maxAttempts: 1 + (opts.retry ?? 0),
        retryDelay: opts.retryDelay ?? 1,
        retryBudgetEnd,
      });
      return {
        id: r.id,
        status: res.status,
        headers: headersOf(res),
        ...encodeBody(await res.bytes()),
      };
    } catch (err) {
      return {
        id: r.id,
        error: `${labelForExitCode(classifyNetworkError(err))}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };

  const results: BatchResult[] = new Array(requests.length);
  let next = 0;
  const parallel = Math.min(opts.parallel ?? DEFAULT_PARALLEL, requests.length);
  try {
    await Promise.all(
      Array.from({ length: parallel }, async () => {
        while (next < requests.length) {
          const index = next++;
          results[index] = await send(requests[index]!);
        }
      }),
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    if (opts.insecure) {
      if (prevTlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTlsReject;
    }
  }

  const out = results.map((r) => `${JSON.stringify(r)}\n`).join("");
  if (opts.output) await Bun.write(opts.output, out);
  else io.stdout.write(out);

  if (!opts.silent && results.some((r) => "status" in r && r.status === 401)) {
    io.stderr.write(
      profileName === undefined
        ? "API key rejected — check --api-key / APPSTRATE_API_KEY (revoked, expired, or for another instance)\n"
        : `Session may be expired — run: ${loginRemedy(profileName, auth.instance)}\n`,
    );
  }
  return io.exit(exitCode(results, opts, writeError));
}

/**
 * Every line valid and on the instance's origin, or the first problem (nothing is sent then).
 * Blank lines are skipped; `id` defaults to the line number, `method` to POST with a body, GET without.
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
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { error: `${where}: expected a JSON object` };
    }
    const { id, method, path, headers, body, ...rest } = raw as Record<string, unknown>;
    const unknown = Object.keys(rest);
    if (unknown.length > 0) return { error: `${where}: unknown field "${unknown[0]}"` };
    if (typeof path !== "string" || path === "") return { error: `${where}: "path" is required` };
    if (method !== undefined && (typeof method !== "string" || !isHttpMethod(method))) {
      return { error: `${where}: "method" must be an HTTP method` };
    }
    if (body !== undefined && typeof body !== "string") {
      return { error: `${where}: "body" must be a string (serialize JSON yourself)` };
    }
    if (
      headers !== undefined &&
      (typeof headers !== "object" ||
        headers === null ||
        Array.isArray(headers) ||
        Object.values(headers).some((v) => typeof v !== "string"))
    ) {
      return { error: `${where}: "headers" must map names to strings` };
    }
    if (id !== undefined && typeof id !== "string")
      return { error: `${where}: "id" must be a string` };
    const lineId = id ?? String(i + 1);
    if (ids.has(lineId)) return { error: `${where}: duplicate id "${lineId}"` };
    ids.add(lineId);
    let url: string;
    try {
      url = toUrl(path);
    } catch (err) {
      if (err instanceof HostMismatchError) return { error: `${where}: ${err.message}` };
      throw err;
    }
    requests.push({
      id: lineId,
      method: method ? method.toUpperCase() : body === undefined ? "GET" : "POST",
      url,
      headers: (headers as Record<string, string> | undefined) ?? {},
      body,
    });
  }
  if (requests.length === 0) return { error: "the batch file holds no request" };
  return { requests };
}

function headersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of res.headers) out[k] = v;
  return out;
}

function encodeBody(bytes: Uint8Array): { body: string; body_encoding: "utf8" | "base64" } {
  try {
    return { body: new TextDecoder("utf-8", { fatal: true }).decode(bytes), body_encoding: "utf8" };
  } catch {
    return { body: Buffer.from(bytes).toString("base64"), body_encoding: "base64" };
  }
}

/**
 * 0 when every request got an answer, 1 when one never did (its line carries the reason);
 * `-f` / `--fail-with-body` add 22 (a 4xx) / 25 (a 5xx). Bodies are written either way.
 */
function exitCode(
  results: BatchResult[],
  opts: ApiCommandOptions,
  writeError: (msg: string) => void,
): number {
  const failed = results.filter((r) => "error" in r);
  if (failed.length > 0) {
    writeError(`${failed.length} of ${results.length} requests got no response\n`);
    return 1;
  }
  if (opts.fail || opts.failWithBody) {
    const statuses = results.map((r) => ("status" in r ? r.status : 0));
    if (statuses.some((s) => s >= 500)) return 25;
    if (statuses.some((s) => s >= 400)) return 22;
  }
  return 0;
}
