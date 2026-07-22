// SPDX-License-Identifier: Apache-2.0

export const RUN_AND_WAIT_MAX_MS = 30 * 60_000;
export const RUN_AND_WAIT_BACKOFF_MS = 500;
const RUN_GET_WAIT_MAX_SECONDS = 55;

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
  if (kind === "agent") {
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
    launchPath =
      `/api/agents/${encodeURIComponent(scope)}/${encodeURIComponent(name)}/run` +
      (qs.size > 0 ? `?${qs.toString()}` : "");
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
        yield { ...step, payload: { ...step.payload, documents } };
        continue;
      }
    }
    yield step;
  }
}
