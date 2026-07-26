// SPDX-License-Identifier: Apache-2.0

import { encodePackageIdPath } from "./naming.ts";

/**
 * Fallback wait ceiling for a caller that has no deadline of its own.
 *
 * A caller that DOES have one (a chat turn, whose ceiling is
 * `CHAT_TURN_DEADLINE_MS` = 10 min) must pass `maxMs` derived from it — this
 * default is three times longer than such a turn, so relying on it means waiting
 * for a result the caller will not be alive to read. See
 * `module-chat/src/run-budget.ts`.
 */
export const RUN_AND_WAIT_MAX_MS = 30 * 60_000;
export const RUN_AND_WAIT_BACKOFF_MS = 500;
const RUN_GET_WAIT_MAX_SECONDS = 55;

/**
 * Inline ceiling for a run's structured `result` inside a tool result (≈8k
 * tokens of JSON). Above it the payload is TRUNCATED and paired with a
 * `document://` pointer at the full copy ({@link truncateRunAndWaitPayload}).
 *
 * Sized as a CONTEXT SAFETY NET, not as the fan-in mechanism (that is the
 * prompt's fan-out/fan-in rule). The 32 KB figure is the same order as the
 * tool-result caps production agent harnesses apply, and it is deliberately NOT
 * aggressive: a 4 KB threshold — the first proposal — would have forced a read
 * round-trip on results the chat must read to answer at all, making the common
 * single-run case strictly worse. The audited incident's results were 9–11.6 KB,
 * i.e. comfortably under this bar: it would not have fired there, and it is not
 * claimed to be that fix.
 */
export const RUN_RESULT_INLINE_MAX_BYTES = 32 * 1024;

/**
 * Name of the `agent_output` document the platform writes when a run's `result`
 * overruns {@link RUN_RESULT_INLINE_MAX_BYTES} — the full payload, so the
 * truncated tool result can point at it. Deliberately platform-namespaced: the
 * match below is by name, and a generic `run-result.json` could collide with a
 * file an agent published itself.
 *
 * Written by `apps/api/src/services/documents.ts` (`spillRunResultDocument`),
 * read here. The constant lives in core because both sides must agree and core
 * is the only package both import — core itself never touches storage.
 */
export const RUN_RESULT_SPILL_DOCUMENT_NAME = "appstrate-run-result.json";

const TEXT_ENCODER = new TextEncoder();
/** Non-fatal: a head cut mid-codepoint yields U+FFFD rather than throwing. */
const TEXT_DECODER = new TextDecoder();

export const RUN_AND_WAIT_TERMINAL_STATUSES = new Set([
  "success",
  "failed",
  "timeout",
  "cancelled",
]);

export interface RunAndWaitStep {
  payload: Record<string, unknown>;
  isError?: boolean;
}

/** A published run document, projected for the tool result the model reads. */
export interface RunAndWaitDocument {
  id: string;
  uri: string;
  name: string;
  mime: string;
  size: number;
}

export interface RunAndWaitLaunch {
  runId: string;
  launchRecord: Record<string, unknown>;
  preliminary: Record<string, unknown>;
  startedAtMs: number;
}

export type RunAndWaitHeaders = Headers | Record<string, string> | Array<[string, string]>;

export interface RunAndWaitClientOptions {
  origin: string;
  headers: RunAndWaitHeaders;
  fetch: typeof fetch;
  signal?: AbortSignal;
  maxMs?: number;
  backoffMs?: number;
}

export interface RunAndWaitLaunchResult {
  ok: true;
  launch: RunAndWaitLaunch;
  /** HTTP status of the launch POST, for the caller's launch-outcome telemetry. */
  launchStatus: number;
}

export interface RunAndWaitFailureResult {
  ok: false;
  step: RunAndWaitStep;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The tool's `context_documents` argument, when the model actually supplied
 * entries. Shape/scheme validation stays server-side (the inline route answers
 * with a field-precise 400) — here we only decide whether to forward it.
 */
function asNonEmptyArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

export function isRunAndWaitTerminalStatus(status: unknown): boolean {
  return typeof status === "string" && RUN_AND_WAIT_TERMINAL_STATUSES.has(status);
}

/**
 * Project a run record onto the documented run_and_wait payload —
 * `{ id, packageId, status, done, result?, error? }` (the exact shape the tool
 * description promises). The full run resource also carries operational fields
 * (cost, token usage, timestamps, config echo) the model has no use for: the
 * chat UI already renders live progress and metrics from the run's SSE stream,
 * and a model that sees a cost or a duration tends to quote it back at the
 * user. A caller that genuinely needs the full resource reads `getRun`.
 */
export function projectRunAndWaitPayload(
  run: Record<string, unknown> | undefined,
  done: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: asString(run?.id) ?? null,
    packageId: asString(run?.packageId) ?? null,
    status: asString(run?.status) ?? null,
    done,
  };
  if (run?.result !== undefined && run.result !== null) payload.result = run.result;
  const error = asString(run?.error);
  if (error) payload.error = error;
  return payload;
}

/**
 * UTF-8 byte length of `value`'s JSON serialization, or null when it does not
 * serialize (cycle, or a value `JSON.stringify` maps to `undefined`).
 */
function serializedResultBytes(value: unknown): Uint8Array | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  return typeof json === "string" ? TEXT_ENCODER.encode(json) : null;
}

/**
 * Does this run result overrun the inline tool-result ceiling? The WRITE side of
 * the spill (the platform's finalize path) asks this so both sides use one
 * threshold and one measurement.
 *
 * The two sides do not measure byte-identical inputs: the writer measures the
 * in-process object, the reader measures the same value after a `jsonb`
 * round-trip (which reorders keys but preserves length). A disagreement is
 * therefore benign in both directions — an unused spill document, or an
 * untruncated payload, never a truncation with no pointer.
 */
export function runResultExceedsInlineLimit(result: unknown): boolean {
  const bytes = serializedResultBytes(result);
  return bytes !== null && bytes.length > RUN_RESULT_INLINE_MAX_BYTES;
}

/**
 * Truncate an oversized `result` on a terminal run_and_wait payload, replacing
 * it with a usable HEAD plus a `document://` pointer at the full copy (D4).
 *
 * Truncate-AND-point, never truncate-or-drop: when no spill document is present
 * (the platform's best-effort write failed, or the run predates it) the payload
 * is returned UNCHANGED. A truncation with no way back to the rest would lose
 * data silently, which is worse than a large tool result.
 *
 * `result` is removed rather than shortened in place: leaving the same key with
 * a shortened value invites the model to treat it as complete. `result_head` is
 * the first {@link RUN_RESULT_INLINE_MAX_BYTES} bytes of the JSON serialization
 * — a prefix, not valid JSON — which in the median case already answers the
 * question, so only a genuinely huge result costs a read round-trip.
 */
export function truncateRunAndWaitPayload(
  payload: Record<string, unknown>,
  documents: readonly RunAndWaitDocument[],
): Record<string, unknown> {
  if (payload.result === undefined || payload.result === null) return payload;
  const bytes = serializedResultBytes(payload.result);
  if (bytes === null || bytes.length <= RUN_RESULT_INLINE_MAX_BYTES) return payload;
  const spill = documents.find((doc) => doc.name === RUN_RESULT_SPILL_DOCUMENT_NAME);
  if (!spill) return payload;

  const { result: _full, ...rest } = payload;
  return {
    ...rest,
    truncated: true,
    result_size_bytes: bytes.length,
    result_head: TEXT_DECODER.decode(bytes.slice(0, RUN_RESULT_INLINE_MAX_BYTES)),
    full_document_uri: spill.uri,
    message:
      `This run's result is ${bytes.length} bytes, over the ` +
      `${RUN_RESULT_INLINE_MAX_BYTES}-byte inline limit for a tool result. ` +
      `\`result_head\` holds its first ${RUN_RESULT_INLINE_MAX_BYTES} bytes as JSON text ` +
      `(a prefix — not parseable on its own). The complete result is stored as the ` +
      `document at \`full_document_uri\`; read it only if the head does not already ` +
      `answer the question, and pass that URI (never a copy of the content) to any ` +
      `follow-up run that needs the whole thing.`,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("Aborted");
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function apiUrl(origin: string, path: string): string {
  return new URL(path, origin).toString();
}

async function readJsonResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function jsonHeaders(headers: RunAndWaitHeaders): Headers {
  const next = new Headers(headers);
  next.set("content-type", "application/json");
  return next;
}

function deadlineError(): Error {
  return new Error("run_and_wait deadline exceeded");
}

function isDeadlineError(err: unknown): boolean {
  return err instanceof Error && err.message === "run_and_wait deadline exceeded";
}

async function fetchWithDeadline(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
): Promise<Response> {
  if (timeoutMs <= 0) throw deadlineError();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(deadlineError()), timeoutMs);
  const onAbort = () => controller.abort(parentSignal?.reason ?? new Error("Aborted"));

  try {
    throwIfAborted(parentSignal);
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onAbort);
  }
}

function waitQueryForRemainingMs(remainingMs: number): string {
  const seconds = Math.floor(remainingMs / 1000);
  return String(Math.max(0, Math.min(seconds, RUN_GET_WAIT_MAX_SECONDS)));
}

export async function launchRunAndWait(
  rawArgs: unknown,
  opts: RunAndWaitClientOptions,
): Promise<RunAndWaitLaunchResult | RunAndWaitFailureResult> {
  const startedAtMs = performance.now();
  const signal = opts.signal;
  throwIfAborted(signal);

  const args = asRecord(rawArgs) ?? {};
  const kind = asString(args.kind);
  const headers = jsonHeaders(opts.headers);

  let launchPath: string;
  let launchBody: Record<string, unknown> | undefined;
  const contextDocuments = asNonEmptyArray(args.context_documents);
  if (kind === "agent") {
    // `context_documents` works by synthesizing an input field on the manifest,
    // which only an inline run owns. A published agent's `input.schema` is a
    // versioned contract the platform must not rewrite — reject explicitly
    // rather than dropping the argument, which would mount nothing and leave
    // the model believing the documents were delivered.
    if (contextDocuments) {
      return {
        ok: false,
        step: {
          payload: {
            error:
              "`context_documents` is only supported for kind:'inline'. To give a published " +
              "agent a document, pass its document:// URI through one of the file fields " +
              'declared in the agent\'s own input schema (`format:"uri"` + `contentMediaType`), ' +
              "via the `input` argument.",
          },
          isError: true,
        },
      };
    }
    const scope = asString(args.scope);
    const name = asString(args.name);
    if (!scope || !name) {
      return {
        ok: false,
        step: {
          payload: { error: "`scope` and `name` are required for kind:'agent'." },
          isError: true,
        },
      };
    }
    const qs = new URLSearchParams();
    const version = asString(args.version);
    if (version) qs.set("version", version);
    // Canonical package-id path encoding (`@`/`/` stay literal) — never
    // hand-roll encodeURIComponent on the segments (see naming.ts).
    let encodedId: string;
    try {
      encodedId = encodePackageIdPath(`${scope}/${name}`);
    } catch {
      return {
        ok: false,
        step: {
          payload: { error: `Invalid agent reference: ${scope}/${name} (expected @scope/name).` },
          isError: true,
        },
      };
    }
    launchPath = `/api/agents/${encodedId}/run` + (qs.size > 0 ? `?${qs.toString()}` : "");
    launchBody = {};
    if (asRecord(args.input)) launchBody.input = args.input;
    if (asRecord(args.config)) launchBody.config = args.config;
    if (Object.keys(launchBody).length === 0) launchBody = undefined;
  } else if (kind === "inline") {
    const manifest = asRecord(args.manifest);
    if (!manifest) {
      return {
        ok: false,
        step: { payload: { error: "`manifest` is required for kind:'inline'." }, isError: true },
      };
    }
    // Reject a missing top-level prompt before hitting the route: the route's
    // field error alone doesn't tell the model WHERE the prompt goes, and the
    // observed failure mode is nesting it inside the manifest (AFPS agents
    // ship a prompt.md, so models naturally put it there) then retrying blind.
    const prompt = asString(args.prompt);
    if (!prompt) {
      const nested = typeof manifest.prompt === "string";
      return {
        ok: false,
        step: {
          payload: {
            error: nested
              ? "`prompt` was found inside `manifest`. It must be a TOP-LEVEL argument of " +
                "run_and_wait, alongside `manifest` — move it out of the manifest and retry."
              : "`prompt` is required for kind:'inline'. Pass it as a top-level argument " +
                "alongside `manifest` (not inside it).",
          },
          isError: true,
        },
      };
    }
    launchPath = "/api/runs/inline";
    launchBody = { manifest, prompt };
    if (asRecord(args.input)) launchBody.input = args.input;
    if (asRecord(args.config)) launchBody.config = args.config;
    // Fan-in by reference: forwarded verbatim; the route resolves each URI
    // through the document ACL and declares the reserved input field itself.
    if (contextDocuments) launchBody.context_documents = contextDocuments;
  } else {
    return {
      ok: false,
      step: { payload: { error: "`kind` must be 'agent' or 'inline'." }, isError: true },
    };
  }

  const launchRes = await opts.fetch(apiUrl(opts.origin, launchPath), {
    method: "POST",
    headers,
    body: launchBody ? JSON.stringify(launchBody) : undefined,
    signal,
  });
  const launched = await readJsonResponse(launchRes);
  if (!launchRes.ok) {
    return {
      ok: false,
      step: { payload: { status: launchRes.status, body: launched }, isError: true },
    };
  }

  const launchRecord = asRecord(launched);
  const runId = asString(launchRecord?.id);
  if (!launchRecord || !runId) {
    return {
      ok: false,
      step: {
        payload: { error: "Run launch returned no run id.", launch: launched },
        isError: true,
      },
    };
  }

  return {
    ok: true,
    launchStatus: launchRes.status,
    launch: {
      runId,
      launchRecord,
      startedAtMs,
      preliminary: {
        id: runId,
        packageId: asString(launchRecord?.packageId) ?? null,
        status: asString(launchRecord?.status) ?? null,
        done: false,
      },
    },
  };
}

export async function waitForRunAndWaitCompletion(
  launch: RunAndWaitLaunch,
  opts: RunAndWaitClientOptions,
): Promise<RunAndWaitStep> {
  const signal = opts.signal;
  const maxMs = opts.maxMs ?? RUN_AND_WAIT_MAX_MS;
  const backoffMs = opts.backoffMs ?? RUN_AND_WAIT_BACKOFF_MS;
  const deadline = launch.startedAtMs + maxMs;
  let lastRun: Record<string, unknown> | undefined;

  while (performance.now() < deadline) {
    throwIfAborted(signal);
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) break;
    const pollStart = performance.now();
    let waitRes: Response;
    try {
      waitRes = await fetchWithDeadline(
        opts.fetch,
        apiUrl(
          opts.origin,
          `/api/runs/${encodeURIComponent(launch.runId)}?wait=${waitQueryForRemainingMs(remainingMs)}`,
        ),
        { method: "GET", headers: opts.headers },
        remainingMs,
        signal,
      );
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      if (isDeadlineError(err) || performance.now() >= deadline) break;
      throw err;
    }
    const run = await readJsonResponse(waitRes);
    if (!waitRes.ok) {
      return { payload: { status: waitRes.status, body: run }, isError: true };
    }

    const runRecord = asRecord(run);
    lastRun = runRecord;
    if (isRunAndWaitTerminalStatus(runRecord?.status)) {
      return { payload: projectRunAndWaitPayload(runRecord, true) };
    }

    const pollMs = performance.now() - pollStart;
    if (pollMs < backoffMs) {
      await sleep(Math.min(backoffMs - pollMs, deadline - performance.now()), signal);
    }
  }

  return {
    payload: {
      ...projectRunAndWaitPayload(lastRun, false),
      id: launch.runId,
      packageId: asString(lastRun?.packageId) ?? asString(launch.launchRecord.packageId) ?? null,
      status: asString(lastRun?.status) ?? asString(launch.launchRecord.status) ?? null,
      error: "run_and_wait timed out before the run reached a terminal status.",
    },
  };
}

export async function* runAndWaitSteps(
  rawArgs: unknown,
  opts: RunAndWaitClientOptions,
): AsyncGenerator<RunAndWaitStep> {
  const launch = await launchRunAndWait(rawArgs, opts);
  if (!launch.ok) {
    yield launch.step;
    return;
  }
  yield { payload: launch.launch.preliminary };
  yield await waitForRunAndWaitCompletion(launch.launch, opts);
}

/**
 * List the agent-output documents a run published, projected to the `{ id, uri,
 * name, mime, size }` shape the tool result embeds. Best-effort: any failure
 * (network, non-2xx, malformed body) yields an empty list — a missing document
 * list must never turn a successful run into a tool error.
 */
export async function fetchRunDocuments(
  runId: string,
  opts: RunAndWaitClientOptions,
): Promise<RunAndWaitDocument[]> {
  try {
    const url = apiUrl(
      opts.origin,
      `/api/documents?run_id=${encodeURIComponent(runId)}&purpose=agent_output&limit=100`,
    );
    const res = await opts.fetch(url, { method: "GET", headers: new Headers(opts.headers) });
    if (!res.ok) return [];
    const data = asRecord(await readJsonResponse(res))?.data;
    if (!Array.isArray(data)) return [];
    const out: RunAndWaitDocument[] = [];
    for (const raw of data) {
      const r = asRecord(raw);
      const id = asString(r?.id);
      const uri = asString(r?.uri);
      const name = asString(r?.name);
      if (!id || !uri || !name) continue;
      out.push({
        id,
        uri,
        name,
        mime: asString(r?.mime) ?? "application/octet-stream",
        size: typeof r?.size === "number" ? r.size : 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Like {@link runAndWaitSteps}, but enriches the FINAL (terminal) step with the
 * run's published `documents` so the model sees `{ uri, name, … }` it can chain
 * into a follow-up run (D6). The extra fetch runs only once the run is terminal
 * and only when a run id exists; a run that published nothing keeps the payload
 * document-free. Used by the chat run_and_wait paths (pi + ai-sdk).
 *
 * The same document list feeds the oversized-result truncation (B5/D4): the
 * spill document the platform wrote for a >32 KB result is found in this list,
 * so the pointer costs no extra request ({@link truncateRunAndWaitPayload}).
 */
export async function* runAndWaitStepsWithDocuments(
  rawArgs: unknown,
  opts: RunAndWaitClientOptions,
): AsyncGenerator<RunAndWaitStep> {
  for await (const step of runAndWaitSteps(rawArgs, opts)) {
    const runId = asString(step.payload.id);
    if (step.payload.done === true && runId) {
      const documents = await fetchRunDocuments(runId, opts);
      if (documents.length > 0) {
        const payload = truncateRunAndWaitPayload(step.payload, documents);
        yield { ...step, payload: { ...payload, documents } };
        continue;
      }
    }
    yield step;
  }
}
