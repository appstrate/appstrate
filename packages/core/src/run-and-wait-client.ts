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
    launchPath = "/api/runs/inline";
    launchBody = { manifest };
    const prompt = asString(args.prompt);
    if (prompt) launchBody.prompt = prompt;
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
      return { payload: { ...runRecord, done: true } };
    }

    const pollMs = performance.now() - pollStart;
    if (pollMs < backoffMs) {
      await sleep(Math.min(backoffMs - pollMs, deadline - performance.now()), signal);
    }
  }

  return {
    payload: {
      ...(lastRun ?? {}),
      id: launch.runId,
      packageId: asString(lastRun?.packageId) ?? asString(launch.launchRecord.packageId) ?? null,
      status: asString(lastRun?.status) ?? asString(launch.launchRecord.status) ?? null,
      done: false,
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
