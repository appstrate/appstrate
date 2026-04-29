// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `runRemote` — the polling-based remote execution path.
 *
 * The runner is exercised end-to-end with an injected `fetch` so each
 * test can script the platform's responses (trigger → log polls → run-
 * record polls → terminal). Polling cadence is set to 1ms so the
 * iteration count drives the timing rather than wall-clock waits.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  runRemote,
  RemoteRunError,
  type RunRemoteOptions,
  type RemoteRunRecord,
  type RemoteRunLog,
} from "../src/commands/run/remote-runner.ts";

// ---------------------------------------------------------------------------
// Test harness — scripted fetch
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | undefined;
}

interface FetchResponseSpec {
  status?: number;
  contentType?: string;
  body: unknown;
}

/**
 * Build a fetch impl that dispatches by URL pattern + method, optionally
 * advancing through a queue of responses for the same key. Each invocation
 * appends to `calls` so tests can assert on the exact request sequence.
 */
function makeFetchImpl(
  routes: Record<string, FetchResponseSpec | FetchResponseSpec[]>,
  calls: FetchCall[],
): typeof fetch {
  // Snapshot of remaining responses per key — mutates as the script runs.
  const queues = new Map<string, FetchResponseSpec[]>();
  for (const [key, spec] of Object.entries(routes)) {
    queues.set(key, Array.isArray(spec) ? [...spec] : [spec]);
  }

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headersObj: Record<string, string> = {};
    const initHeaders = init?.headers;
    if (initHeaders) {
      const h = new Headers(initHeaders);
      h.forEach((v, k) => {
        headersObj[k] = v;
      });
    }
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url: urlStr, method, headers: headersObj, body });

    // Match by `<METHOD> <pathPattern>` keys. The patterns are URL-suffix
    // checks so query strings and origins can vary without breaking matches.
    const key = matchRoute(method, urlStr, queues);
    if (!key) {
      throw new Error(`unrouted fetch: ${method} ${urlStr}`);
    }
    const queue = queues.get(key)!;
    const spec = queue.length > 1 ? queue.shift()! : queue[0]!;

    const responseBody =
      spec.contentType === "text/plain" || typeof spec.body === "string"
        ? String(spec.body)
        : JSON.stringify(spec.body);

    return new Response(responseBody, {
      status: spec.status ?? 200,
      headers: { "Content-Type": spec.contentType ?? "application/json" },
    });
  };
  // Bun's `typeof fetch` carries a `preconnect` static method we don't
  // need to model in tests — the cast is safe because the runner only
  // ever calls the function form.
  return impl as unknown as typeof fetch;
}

function matchRoute(
  method: string,
  url: string,
  queues: Map<string, FetchResponseSpec[]>,
): string | null {
  for (const key of queues.keys()) {
    const [m, ...rest] = key.split(" ");
    const pattern = rest.join(" ");
    if (m !== method) continue;
    if (url.includes(pattern)) return key;
  }
  return null;
}

interface CapturedWriters {
  stdout: string[];
  stderr: string[];
  files: Record<string, string>;
}

function makeWriters(): CapturedWriters {
  return { stdout: [], stderr: [], files: {} };
}

function buildBaseOpts(over: Partial<RunRemoteOptions> = {}): RunRemoteOptions {
  return {
    instance: "https://app.example.com",
    bearerToken: "ask_test_key",
    appId: "app_1",
    orgId: "org_1",
    scope: "@system",
    name: "hello-world",
    input: { greeting: "hi" },
    config: {},
    json: false,
    bundleLabel: "@system/hello-world",
    pollIntervalMs: 1,
    ...over,
  };
}

function recordSummary(over: Partial<RemoteRunRecord> = {}): RemoteRunRecord {
  return {
    id: "run_test_1",
    status: "success",
    packageId: "@system/hello-world",
    applicationId: "app_1",
    orgId: "org_1",
    result: { ok: true },
    error: null,
    cost: 0.0123,
    startedAt: "2026-04-29T10:00:00Z",
    completedAt: "2026-04-29T10:00:42Z",
    duration: 42_000,
    ...over,
  };
}

let writers: CapturedWriters;
beforeEach(() => {
  writers = makeWriters();
});

function withCapturedWriters(opts: RunRemoteOptions): RunRemoteOptions {
  return {
    ...opts,
    writeStdout: (chunk) => writers.stdout.push(chunk),
    writeStderr: (chunk) => writers.stderr.push(chunk),
    writeFile: async (p, contents) => {
      writers.files[p] = contents;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runRemote — happy path", () => {
  it("triggers, polls to terminal success, returns exit code 0", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/%40system/hello-world/run": {
          status: 200,
          body: { runId: "run_test_1" },
        },
        "GET /api/runs/run_test_1/logs": [
          {
            status: 200,
            body: [
              {
                id: 1,
                runId: "run_test_1",
                type: "system",
                event: "started",
                message: "boot",
                level: "info",
              },
            ] satisfies RemoteRunLog[],
          },
          {
            status: 200,
            body: [
              {
                id: 1,
                runId: "run_test_1",
                type: "system",
                event: "started",
                message: "boot",
                level: "info",
              },
              {
                id: 2,
                runId: "run_test_1",
                type: "appstrate",
                event: null,
                message: "thinking",
                level: "info",
              },
            ] satisfies RemoteRunLog[],
          },
        ],
        "GET /api/runs/run_test_1": [
          { status: 200, body: recordSummary({ status: "running" }) },
          { status: 200, body: recordSummary({ status: "success" }) },
        ],
      },
      calls,
    );

    const opts = withCapturedWriters(buildBaseOpts({ fetchImpl }));
    const outcome = await runRemote(opts, new AbortController().signal);

    expect(outcome.runId).toBe("run_test_1");
    expect(outcome.status).toBe("success");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.logs).toHaveLength(2);
    expect(outcome.logs.map((l) => l.id)).toEqual([1, 2]);
    expect(outcome.record.cost).toBe(0.0123);

    // Trigger headers carry the bearer + X-App-Id + X-Org-Id
    const trigger = calls.find((c) => c.method === "POST" && c.url.includes("/run"))!;
    expect(trigger.headers["authorization"]).toBe("Bearer ask_test_key");
    expect(trigger.headers["x-app-id"]).toBe("app_1");
    expect(trigger.headers["x-org-id"]).toBe("org_1");
    expect(JSON.parse(trigger.body!)).toEqual({ input: { greeting: "hi" }, config: {} });

    // Stderr summary mentions success
    const summary = writers.stderr.join("");
    expect(summary).toMatch(/success/);
    expect(summary).toMatch(/\$0\.0123/);
  });

  it("forwards modelId, proxyId, and version override to the trigger", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/%40scope/agent/run": { status: 200, body: { runId: "run_2" } },
        "GET /api/runs/run_2/logs": { status: 200, body: [] },
        "GET /api/runs/run_2": {
          status: 200,
          body: recordSummary({ id: "run_2", status: "success" }),
        },
      },
      calls,
    );

    const opts = withCapturedWriters(
      buildBaseOpts({
        fetchImpl,
        scope: "@scope",
        name: "agent",
        spec: "1.2.3",
        modelId: "claude-opus-4-7",
        proxyId: "px_test",
      }),
    );

    await runRemote(opts, new AbortController().signal);

    const trigger = calls.find((c) => c.method === "POST" && c.url.includes("/run"))!;
    expect(trigger.url).toContain("version=1.2.3");
    const body = JSON.parse(trigger.body!);
    expect(body.modelId).toBe("claude-opus-4-7");
    expect(body.proxyId).toBe("px_test");
  });

  it("forwards Idempotency-Key when provided", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/%40system/hello-world/run": { status: 200, body: { runId: "run_3" } },
        "GET /api/runs/run_3/logs": { status: 200, body: [] },
        "GET /api/runs/run_3": {
          status: 200,
          body: recordSummary({ id: "run_3", status: "success" }),
        },
      },
      calls,
    );

    const opts = withCapturedWriters(buildBaseOpts({ fetchImpl, idempotencyKey: "k_abc123" }));
    await runRemote(opts, new AbortController().signal);

    const trigger = calls.find((c) => c.method === "POST" && c.url.includes("/run"))!;
    expect(trigger.headers["idempotency-key"]).toBe("k_abc123");
  });

  it("writes the final RunResult JSON to --output path when set", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/%40system/hello-world/run": { status: 200, body: { runId: "run_4" } },
        "GET /api/runs/run_4/logs": { status: 200, body: [] },
        "GET /api/runs/run_4": {
          status: 200,
          body: recordSummary({ id: "run_4", status: "success", result: { final: 42 } }),
        },
      },
      calls,
    );

    const opts = withCapturedWriters(buildBaseOpts({ fetchImpl, outputPath: "/tmp/out.json" }));
    await runRemote(opts, new AbortController().signal);

    expect(writers.files["/tmp/out.json"]).toBeDefined();
    const parsed = JSON.parse(writers.files["/tmp/out.json"]!);
    expect(parsed.runId).toBe("run_4");
    expect(parsed.status).toBe("success");
    expect(parsed.result).toEqual({ final: 42 });
  });

  it("emits JSONL events on stdout in --json mode", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/%40system/hello-world/run": { status: 200, body: { runId: "run_5" } },
        "GET /api/runs/run_5/logs": {
          status: 200,
          body: [
            {
              id: 1,
              runId: "run_5",
              type: "system",
              event: "started",
              message: "boot",
              level: "info",
            },
          ] satisfies RemoteRunLog[],
        },
        "GET /api/runs/run_5": {
          status: 200,
          body: recordSummary({ id: "run_5", status: "success" }),
        },
      },
      calls,
    );

    const opts = withCapturedWriters(buildBaseOpts({ fetchImpl, json: true }));
    await runRemote(opts, new AbortController().signal);

    const lines = writers.stdout.join("").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3); // triggered + log + finalize
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toContain("appstrate.remote.triggered");
    expect(types).toContain("appstrate.remote.log");
    expect(types).toContain("appstrate.remote.finalize");
  });
});

describe("runRemote — non-success terminals", () => {
  it("returns exit code 1 on `failed` status", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/%40system/hello-world/run": { status: 200, body: { runId: "run_f" } },
        "GET /api/runs/run_f/logs": { status: 200, body: [] },
        "GET /api/runs/run_f": {
          status: 200,
          body: recordSummary({ id: "run_f", status: "failed", error: "boom" }),
        },
      },
      calls,
    );

    const opts = withCapturedWriters(buildBaseOpts({ fetchImpl }));
    const outcome = await runRemote(opts, new AbortController().signal);
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(1);
    expect(writers.stderr.join("")).toMatch(/boom/);
  });

  it("returns exit code 1 on `timeout` status", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/%40system/hello-world/run": { status: 200, body: { runId: "run_t" } },
        "GET /api/runs/run_t/logs": { status: 200, body: [] },
        "GET /api/runs/run_t": {
          status: 200,
          body: recordSummary({ id: "run_t", status: "timeout" }),
        },
      },
      calls,
    );

    const outcome = await runRemote(
      withCapturedWriters(buildBaseOpts({ fetchImpl })),
      new AbortController().signal,
    );
    expect(outcome.status).toBe("timeout");
    expect(outcome.exitCode).toBe(1);
  });
});

describe("runRemote — cancellation", () => {
  it("POSTs cancel on signal abort and continues until terminal", async () => {
    const calls: FetchCall[] = [];
    let recordHits = 0;
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/%40system/hello-world/run": { status: 200, body: { runId: "run_c" } },
        "GET /api/runs/run_c/logs": { status: 200, body: [] },
        "GET /api/runs/run_c": [
          { status: 200, body: recordSummary({ id: "run_c", status: "running" }) },
          { status: 200, body: recordSummary({ id: "run_c", status: "running" }) },
          {
            status: 200,
            body: recordSummary({ id: "run_c", status: "cancelled", error: "Cancelled by user" }),
          },
        ],
        "POST /api/runs/run_c/cancel": { status: 200, body: { ok: true } },
      },
      calls,
    );

    const ctrl = new AbortController();
    // Wrap the fetch impl to abort after the first record poll, then let
    // the runner observe the cancellation on subsequent polls.
    const wrappedImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const res = await fetchImpl(input, init);
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/runs/run_c") && (init?.method ?? "GET").toUpperCase() === "GET") {
        recordHits++;
        if (recordHits === 1) ctrl.abort();
      }
      return res;
    };
    const wrapped = wrappedImpl as unknown as typeof fetch;

    const outcome = await runRemote(
      withCapturedWriters(buildBaseOpts({ fetchImpl: wrapped })),
      ctrl.signal,
    );

    expect(outcome.status).toBe("cancelled");
    expect(outcome.exitCode).toBe(1);
    const cancelCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/cancel"));
    expect(cancelCall).toBeDefined();
  });

  it("does not double-fire cancel on repeated abort events", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/%40system/hello-world/run": { status: 200, body: { runId: "run_dc" } },
        "GET /api/runs/run_dc/logs": { status: 200, body: [] },
        "GET /api/runs/run_dc": {
          status: 200,
          body: recordSummary({ id: "run_dc", status: "cancelled" }),
        },
        "POST /api/runs/run_dc/cancel": { status: 200, body: { ok: true } },
      },
      calls,
    );

    const ctrl = new AbortController();
    ctrl.abort(); // already aborted before triggering
    await runRemote(withCapturedWriters(buildBaseOpts({ fetchImpl })), ctrl.signal);

    const cancelCalls = calls.filter((c) => c.method === "POST" && c.url.endsWith("/cancel"));
    expect(cancelCalls).toHaveLength(1);
  });
});

describe("runRemote — error paths", () => {
  it("throws RemoteRunError with hint on 401", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/%40system/hello-world/run": {
          status: 401,
          body: { detail: "Unauthorized" },
        },
      },
      calls,
    );

    const opts = withCapturedWriters(buildBaseOpts({ fetchImpl }));
    await expect(runRemote(opts, new AbortController().signal)).rejects.toMatchObject({
      name: "RemoteRunError",
      status: 401,
    });

    try {
      await runRemote(opts, new AbortController().signal);
    } catch (err) {
      if (!(err instanceof RemoteRunError)) throw err;
      expect(err.hint).toMatch(/agents:run/);
    }
  });

  it("throws RemoteRunError on 404 with agent-not-found hint", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/%40system/missing/run": {
          status: 404,
          body: { detail: "Agent not found" },
        },
      },
      calls,
    );

    const opts = withCapturedWriters(buildBaseOpts({ fetchImpl, name: "missing" }));
    try {
      await runRemote(opts, new AbortController().signal);
      throw new Error("expected throw");
    } catch (err) {
      if (!(err instanceof RemoteRunError)) throw err;
      expect(err.hint).toMatch(/not found/);
    }
  });

  it("throws RemoteRunError when trigger response lacks runId", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/%40system/hello-world/run": {
          status: 200,
          body: { somethingElse: true },
        },
      },
      calls,
    );

    await expect(
      runRemote(withCapturedWriters(buildBaseOpts({ fetchImpl })), new AbortController().signal),
    ).rejects.toMatchObject({ name: "RemoteRunError" });
  });

  it("treats logs endpoint failures as non-fatal (keeps polling the run record)", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/%40system/hello-world/run": { status: 200, body: { runId: "run_ll" } },
        "GET /api/runs/run_ll/logs": { status: 500, body: { error: "transient" } },
        "GET /api/runs/run_ll": {
          status: 200,
          body: recordSummary({ id: "run_ll", status: "success" }),
        },
      },
      calls,
    );

    const outcome = await runRemote(
      withCapturedWriters(buildBaseOpts({ fetchImpl })),
      new AbortController().signal,
    );
    expect(outcome.status).toBe("success");
    expect(outcome.logs).toHaveLength(0);
  });
});

describe("runRemote — log dedup", () => {
  it("does not double-render logs across polls", async () => {
    const calls: FetchCall[] = [];
    const log = (id: number, msg: string): RemoteRunLog => ({
      id,
      runId: "run_dd",
      type: "appstrate",
      event: null,
      message: msg,
      level: "info",
    });
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/%40system/hello-world/run": { status: 200, body: { runId: "run_dd" } },
        "GET /api/runs/run_dd/logs": [
          { status: 200, body: [log(1, "a")] },
          { status: 200, body: [log(1, "a"), log(2, "b")] },
          { status: 200, body: [log(1, "a"), log(2, "b"), log(3, "c")] },
        ],
        "GET /api/runs/run_dd": [
          { status: 200, body: recordSummary({ id: "run_dd", status: "running" }) },
          { status: 200, body: recordSummary({ id: "run_dd", status: "running" }) },
          { status: 200, body: recordSummary({ id: "run_dd", status: "success" }) },
        ],
      },
      calls,
    );

    const outcome = await runRemote(
      withCapturedWriters(buildBaseOpts({ fetchImpl })),
      new AbortController().signal,
    );

    expect(outcome.logs.map((l) => l.id)).toEqual([1, 2, 3]);
    // Each log message should appear exactly once on stderr
    const stderr = writers.stderr.join("");
    expect((stderr.match(/\] a/g) ?? []).length).toBe(1);
    expect((stderr.match(/\] b/g) ?? []).length).toBe(1);
    expect((stderr.match(/\] c/g) ?? []).length).toBe(1);
  });
});
