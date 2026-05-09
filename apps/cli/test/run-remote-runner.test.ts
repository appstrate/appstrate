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
    applicationId: "app_1",
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

describe("runRemote — URL encoding (regression #355)", () => {
  it("trigger URL contains a literal '@', never percent-encoded", async () => {
    // Hono's RegExpRouter route `/agents/:scope{@[^/]+}/:name/run` matches
    // against the raw (encoded) request path. `encodeURIComponent("@x")`
    // produces `%40x`, which fails the `@[^/]+` constraint and 404s. Same
    // gotcha as `bundle-fetch.ts:buildBundleUrl` — kept as a regression
    // test so a future "let's encode for safety" refactor doesn't silently
    // break every published-agent run.
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@pierre-cabriere/hello-world/run": {
          status: 200,
          body: { runId: "run_url" },
        },
        "GET /api/runs/run_url/logs": { status: 200, body: [] },
        "GET /api/runs/run_url": {
          status: 200,
          body: recordSummary({ id: "run_url", status: "success" }),
        },
      },
      calls,
    );

    await runRemote(
      withCapturedWriters(
        buildBaseOpts({
          fetchImpl,
          scope: "@pierre-cabriere",
          name: "hello-world",
        }),
      ),
      new AbortController().signal,
    );

    const trigger = calls.find((c) => c.method === "POST" && c.url.includes("/run"))!;
    expect(trigger.url).toContain("/api/agents/@pierre-cabriere/hello-world/run");
    expect(trigger.url).not.toContain("%40");
  });
});

describe("runRemote — happy path", () => {
  it("triggers, polls to terminal success, returns exit code 0", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@system/hello-world/run": {
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
                type: "progress",
                event: "progress",
                message: "runtime ready in 39ms",
                level: "info",
              },
            ] satisfies RemoteRunLog[],
          },
          {
            status: 200,
            body: [
              {
                id: 2,
                runId: "run_test_1",
                type: "progress",
                event: "progress",
                message: "thinking",
                level: "info",
              },
            ] satisfies RemoteRunLog[],
          },
        ],
        "GET /api/runs/run_test_1": [
          { status: 200, body: recordSummary({ status: "running" }) },
          {
            status: 200,
            body: recordSummary({
              status: "success",
              tokenUsage: { input_tokens: 100, output_tokens: 200 },
            }),
          },
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

    // Trigger headers carry the bearer + X-Application-Id + X-Org-Id
    const trigger = calls.find((c) => c.method === "POST" && c.url.includes("/run"))!;
    expect(trigger.headers["authorization"]).toBe("Bearer ask_test_key");
    expect(trigger.headers["x-application-id"]).toBe("app_1");
    expect(trigger.headers["x-org-id"]).toBe("org_1");
    expect(JSON.parse(trigger.body!)).toEqual({ input: { greeting: "hi" }, config: {} });

    // Stderr carries the "→ running" preamble (parity with local mode).
    expect(writers.stderr.join("")).toContain("→ running @system/hello-world (reporting to");

    // Stdout carries the events: progress messages, the metric line,
    // and the `[run complete]` finalize line — same surface the local
    // human sink emits.
    const stdout = writers.stdout.join("");
    expect(stdout).toContain("→ runtime ready in 39ms");
    expect(stdout).toContain("→ thinking");
    expect(stdout).toContain("[run complete]");
    expect(stdout).toMatch(/∑ tokens in=100 out=200 +\$0\.0123/);
  });

  it("forwards modelId, proxyId, and version override to the trigger", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@scope/agent/run": { status: 200, body: { runId: "run_2" } },
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
        "POST /api/agents/@system/hello-world/run": { status: 200, body: { runId: "run_3" } },
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
        "POST /api/agents/@system/hello-world/run": { status: 200, body: { runId: "run_4" } },
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
    // Shape parity with the local `--output` (canonical AFPS RunResult).
    // No `runId`/`instance` on the wire payload — those are the runner's
    // private debugging extras carried only on stderr/JSONL envelopes.
    // The local `RunResult` has no such fields and we want byte-for-byte
    // parity here.
    expect(parsed.status).toBe("success");
    expect(parsed.output).toEqual({ final: 42 });
    expect(parsed.memories).toEqual([]);
    expect(parsed.pinned).toEqual({});
    expect(parsed.logs).toEqual([]);
    expect(parsed.durationMs).toBe(42_000);
    expect(parsed.cost).toBe(0.0123);
    expect(parsed.error).toBeUndefined();
    expect(parsed.runId).toBeUndefined();
    expect(parsed.instance).toBeUndefined();
  });

  it("--output payload carries error envelope on non-success", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@system/hello-world/run": { status: 200, body: { runId: "run_4e" } },
        "GET /api/runs/run_4e/logs": { status: 200, body: [] },
        "GET /api/runs/run_4e": {
          status: 200,
          body: recordSummary({
            id: "run_4e",
            status: "failed",
            error: "Provider rejected request",
            result: null,
          }),
        },
      },
      calls,
    );

    const opts = withCapturedWriters(buildBaseOpts({ fetchImpl, outputPath: "/tmp/out.err.json" }));
    await runRemote(opts, new AbortController().signal);

    const parsed = JSON.parse(writers.files["/tmp/out.err.json"]!);
    expect(parsed.status).toBe("failed");
    // `RunError` shape — local writes `{ code, message }`. We supply a
    // canonical `code` so consumers downstream can branch on it instead
    // of having to parse the human message.
    expect(parsed.error).toEqual({
      code: "remote_run_error",
      message: "Provider rejected request",
    });
    expect(parsed.output).toBeNull();
  });

  it("emits canonical RunEvents on stdout in --json mode (parity with local)", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@system/hello-world/run": { status: 200, body: { runId: "run_5" } },
        "GET /api/runs/run_5/logs": {
          status: 200,
          body: [
            {
              id: 1,
              runId: "run_5",
              type: "progress",
              event: "progress",
              message: "runtime ready in 12ms",
              level: "info",
            },
            {
              id: 2,
              runId: "run_5",
              type: "result",
              event: "output",
              message: null,
              data: { greeting: "hi" },
              level: "info",
            },
          ] satisfies RemoteRunLog[],
        },
        "GET /api/runs/run_5": {
          status: 200,
          body: recordSummary({
            id: "run_5",
            status: "success",
            tokenUsage: { input_tokens: 10, output_tokens: 20 },
          }),
        },
      },
      calls,
    );

    const opts = withCapturedWriters(buildBaseOpts({ fetchImpl, json: true }));
    await runRemote(opts, new AbortController().signal);

    const lines = writers.stdout.join("").split("\n").filter(Boolean);
    const types = lines.map((l) => JSON.parse(l).type);

    // The remote runner emits the same canonical event vocabulary as
    // the local path — `appstrate.progress`, `output.emitted`,
    // `appstrate.metric`, `appstrate.finalize` — plus its own
    // `appstrate.remote.triggered` envelope as the very first line so
    // jq pipelines can pick the run id without parsing logs.
    expect(types[0]).toBe("appstrate.remote.triggered");
    expect(types).toContain("appstrate.progress");
    expect(types).toContain("output.emitted");
    expect(types).toContain("appstrate.metric");
    expect(types).toContain("appstrate.finalize");

    // Sanity-check the metric shape — usage + cost flow through.
    const metric = lines.map((l) => JSON.parse(l)).find((e) => e.type === "appstrate.metric");
    expect(metric.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
    expect(metric.cost).toBe(0.0123);
  });
});

describe("runRemote — non-success terminals", () => {
  it("returns exit code 1 on `failed` status", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@system/hello-world/run": { status: 200, body: { runId: "run_f" } },
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
    // Local sink renders failures as `[run failed] <message>` on stdout
    // (its writeStdout target). Same here for parity.
    expect(writers.stdout.join("")).toMatch(/\[run failed\] boom/);
  });

  it("returns exit code 1 on `timeout` status", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@system/hello-world/run": { status: 200, body: { runId: "run_t" } },
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
        "POST /api/agents/@system/hello-world/run": { status: 200, body: { runId: "run_c" } },
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
        "POST /api/agents/@system/hello-world/run": { status: 200, body: { runId: "run_dc" } },
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
        "POST /api/agents/@system/hello-world/run": {
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
        "POST /api/agents/@system/missing/run": {
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
        "POST /api/agents/@system/hello-world/run": {
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
        "POST /api/agents/@system/hello-world/run": { status: 200, body: { runId: "run_ll" } },
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
      type: "progress",
      event: "progress",
      message: msg,
      level: "info",
    });
    // Fixture returns full lists every poll — even with the `?since=`
    // cursor wired in, `seenLogIds` defense-in-depth dedup must still
    // catch a server that fails to honor the cursor.
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@system/hello-world/run": { status: 200, body: { runId: "run_dd" } },
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
      withCapturedWriters(buildBaseOpts({ fetchImpl, recordPollEveryNTicks: 1 })),
      new AbortController().signal,
    );

    expect(outcome.logs.map((l) => l.id)).toEqual([1, 2, 3]);
    // Each progress message should appear exactly once on stdout — the
    // sink renders `appstrate.progress` events with a `→ ` prefix.
    const stdout = writers.stdout.join("");
    expect((stdout.match(/→ a$/gm) ?? []).length).toBe(1);
    expect((stdout.match(/→ b$/gm) ?? []).length).toBe(1);
    expect((stdout.match(/→ c$/gm) ?? []).length).toBe(1);
  });
});

describe("runRemote — log cursor (?since=)", () => {
  it("first poll omits ?since=, subsequent polls send the highest seen id", async () => {
    const calls: FetchCall[] = [];
    const log = (id: number): RemoteRunLog => ({
      id,
      runId: "run_cursor",
      type: "progress",
      event: "progress",
      message: `m${id}`,
      level: "info",
    });
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@system/hello-world/run": {
          status: 200,
          body: { runId: "run_cursor" },
        },
        "GET /api/runs/run_cursor/logs": [
          { status: 200, body: [log(1), log(2)] },
          { status: 200, body: [log(3)] },
          { status: 200, body: [] },
        ],
        "GET /api/runs/run_cursor": [
          { status: 200, body: recordSummary({ id: "run_cursor", status: "running" }) },
          { status: 200, body: recordSummary({ id: "run_cursor", status: "running" }) },
          { status: 200, body: recordSummary({ id: "run_cursor", status: "success" }) },
        ],
      },
      calls,
    );

    const outcome = await runRemote(
      withCapturedWriters(buildBaseOpts({ fetchImpl, recordPollEveryNTicks: 1 })),
      new AbortController().signal,
    );

    expect(outcome.logs.map((l) => l.id)).toEqual([1, 2, 3]);

    // Inspect the sequence of /logs requests: first must be cursor-less,
    // subsequent ones must carry `?since=<lastSeenId>`.
    const logCalls = calls.filter(
      (c) => c.method === "GET" && c.url.includes("/api/runs/run_cursor/logs"),
    );
    expect(logCalls.length).toBeGreaterThanOrEqual(2);
    expect(logCalls[0]!.url).not.toContain("since=");
    expect(logCalls[1]!.url).toContain("since=2");
    if (logCalls.length >= 3) {
      expect(logCalls[2]!.url).toContain("since=3");
    }
  });

  it("cursor advances across the final tail fetch (post-terminal)", async () => {
    const calls: FetchCall[] = [];
    const log = (id: number): RemoteRunLog => ({
      id,
      runId: "run_tail",
      type: "progress",
      event: "progress",
      message: `m${id}`,
      level: "info",
    });
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@system/hello-world/run": { status: 200, body: { runId: "run_tail" } },
        "GET /api/runs/run_tail/logs": [
          { status: 200, body: [log(1)] },
          // After terminal, the post-terminal "tail" fetch picks up a
          // straggler log id=2 committed in the same transaction as the
          // status flip.
          { status: 200, body: [log(2)] },
        ],
        "GET /api/runs/run_tail": {
          status: 200,
          body: recordSummary({ id: "run_tail", status: "success" }),
        },
      },
      calls,
    );

    const outcome = await runRemote(
      withCapturedWriters(buildBaseOpts({ fetchImpl, recordPollEveryNTicks: 1 })),
      new AbortController().signal,
    );

    expect(outcome.logs.map((l) => l.id)).toEqual([1, 2]);
    // Two log calls: the loop poll (no since) and the post-terminal tail
    // (since=1, the highest id rendered before the terminal record).
    const logCalls = calls.filter(
      (c) => c.method === "GET" && c.url.includes("/api/runs/run_tail/logs"),
    );
    expect(logCalls).toHaveLength(2);
    expect(logCalls[0]!.url).not.toContain("since=");
    expect(logCalls[1]!.url).toContain("since=1");
  });
});

describe("runRemote — record-poll cadence", () => {
  it("does not refetch the run record every tick on a quiet run", async () => {
    const calls: FetchCall[] = [];
    // Long-idle run: no logs ever. With recordPollEveryNTicks=3, the
    // loop fetches the record on tick 0 (running) and tick 3 (success →
    // break). The post-loop final fetch in step 4 is the third call.
    // Without the cadence throttle, an every-tick fetch would land 4+
    // record polls here; the assertion guards against regressing back
    // to log-activity-driven refresh.
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@system/hello-world/run": { status: 200, body: { runId: "run_quiet" } },
        "GET /api/runs/run_quiet/logs": { status: 200, body: [] },
        "GET /api/runs/run_quiet": [
          { status: 200, body: recordSummary({ id: "run_quiet", status: "running" }) },
          { status: 200, body: recordSummary({ id: "run_quiet", status: "success" }) },
        ],
      },
      calls,
    );

    await runRemote(
      withCapturedWriters(buildBaseOpts({ fetchImpl, recordPollEveryNTicks: 3 })),
      new AbortController().signal,
    );

    const recordCalls = calls.filter(
      (c) => c.method === "GET" && c.url.endsWith("/api/runs/run_quiet"),
    );
    // Loop: tick 0 (running) + tick 3 (success → break) = 2.
    // Plus the post-loop final fetch = 3 total.
    expect(recordCalls.length).toBe(3);

    // Logs are polled every tick — over 4 ticks (0..3) we expect 4 log
    // calls in the loop + 1 final fetch = 5. This proves the record
    // fetches stayed throttled while the log poll ran each tick.
    const logCalls = calls.filter(
      (c) => c.method === "GET" && c.url.includes("/api/runs/run_quiet/logs"),
    );
    expect(logCalls.length).toBeGreaterThanOrEqual(4);
  });
});

describe("runRemote — trigger response shape", () => {
  it("rejects a 200 response that is not a JSON object", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@system/hello-world/run": {
          status: 200,
          contentType: "text/plain",
          body: "ok",
        },
      },
      calls,
    );

    try {
      await runRemote(
        withCapturedWriters(buildBaseOpts({ fetchImpl })),
        new AbortController().signal,
      );
      throw new Error("expected throw");
    } catch (err) {
      if (!(err instanceof RemoteRunError)) throw err;
      expect(err.message).toMatch(/non-JSON|missing/i);
    }
  });

  it("rejects a 200 response where runId is not a string", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@system/hello-world/run": {
          status: 200,
          body: { runId: 12345 },
        },
      },
      calls,
    );

    try {
      await runRemote(
        withCapturedWriters(buildBaseOpts({ fetchImpl })),
        new AbortController().signal,
      );
      throw new Error("expected throw");
    } catch (err) {
      if (!(err instanceof RemoteRunError)) throw err;
      expect(err.message).toMatch(/runId/);
      expect(err.hint).toBeDefined();
    }
  });

  it("rejects a 200 response with empty-string runId", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@system/hello-world/run": {
          status: 200,
          body: { runId: "" },
        },
      },
      calls,
    );

    try {
      await runRemote(
        withCapturedWriters(buildBaseOpts({ fetchImpl })),
        new AbortController().signal,
      );
      throw new Error("expected throw");
    } catch (err) {
      if (!(err instanceof RemoteRunError)) throw err;
      expect(err.message).toMatch(/runId/);
    }
  });
});

describe("runRemote — trigger retry on transient 5xx", () => {
  // The trigger POST is the one fetch in the runner that we cannot afford
  // to lose to a transient backend hiccup — failing it propagates to
  // `exitWithError` and the user sees an unhelpful "Trigger failed: 503"
  // when the next attempt would have succeeded. The retry uses fixed
  // backoffs and is bounded; the Idempotency-Key (when set) makes a retry
  // semantically equivalent to a single call.
  it("retries on 503 and succeeds on the second attempt", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@system/hello-world/run": [
          { status: 503, body: { error: "service unavailable" } },
          { status: 200, body: { runId: "run_retry_1" } },
        ],
        "GET /api/runs/run_retry_1/logs": { status: 200, body: [] },
        "GET /api/runs/run_retry_1": {
          status: 200,
          body: recordSummary({ id: "run_retry_1", status: "success" }),
        },
      },
      calls,
    );

    const outcome = await runRemote(
      withCapturedWriters(buildBaseOpts({ fetchImpl })),
      new AbortController().signal,
    );
    expect(outcome.runId).toBe("run_retry_1");
    expect(outcome.status).toBe("success");
    // Two trigger POSTs: the 503 and the successful retry.
    const triggerCalls = calls.filter((c) => c.method === "POST" && c.url.endsWith("/run"));
    expect(triggerCalls).toHaveLength(2);
  });

  it("retries on 502 and 504 too", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@system/hello-world/run": [
          { status: 502, body: { error: "bad gateway" } },
          { status: 504, body: { error: "gateway timeout" } },
          { status: 200, body: { runId: "run_retry_2" } },
        ],
        "GET /api/runs/run_retry_2/logs": { status: 200, body: [] },
        "GET /api/runs/run_retry_2": {
          status: 200,
          body: recordSummary({ id: "run_retry_2", status: "success" }),
        },
      },
      calls,
    );

    const outcome = await runRemote(
      withCapturedWriters(buildBaseOpts({ fetchImpl })),
      new AbortController().signal,
    );
    expect(outcome.runId).toBe("run_retry_2");
  });

  it("gives up after the configured retry budget is exhausted", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        // The same 503 response is repeated for every attempt — the
        // queue with a single entry is replayed indefinitely by the
        // test harness. The runner caps at 3 total attempts (initial +
        // 2 retries from TRANSIENT_RETRY_DELAYS_MS).
        "POST /api/agents/@system/hello-world/run": {
          status: 503,
          body: { error: "service unavailable" },
        },
      },
      calls,
    );

    await expect(
      runRemote(withCapturedWriters(buildBaseOpts({ fetchImpl })), new AbortController().signal),
    ).rejects.toMatchObject({ name: "RemoteRunError", status: 503 });
    const triggerCalls = calls.filter((c) => c.method === "POST" && c.url.endsWith("/run"));
    // Initial attempt + 2 retries = 3 total.
    expect(triggerCalls).toHaveLength(3);
  });

  it("does NOT retry on 4xx (auth, not-found, validation are not transient)", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@system/hello-world/run": {
          status: 401,
          body: { detail: "Unauthorized" },
        },
      },
      calls,
    );

    await expect(
      runRemote(withCapturedWriters(buildBaseOpts({ fetchImpl })), new AbortController().signal),
    ).rejects.toMatchObject({ name: "RemoteRunError", status: 401 });
    // Only a single attempt — 4xx is not retried.
    const triggerCalls = calls.filter((c) => c.method === "POST" && c.url.endsWith("/run"));
    expect(triggerCalls).toHaveLength(1);
  });
});

describe("runRemote — record-poll resilience", () => {
  // A transient 5xx on the run-record refresh used to crash the whole
  // runner — losing the user's already-printed log tail and any in-flight
  // cancellation. Symmetric with `fetchLogs`'s soft-fail, the runner now
  // warns and retries on the next cadence, so a momentary network blip
  // never aborts an otherwise-successful run.
  it("ignores a transient 500 on the record poll and reaches terminal on retry", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = makeFetchImpl(
      {
        "POST /api/agents/@system/hello-world/run": { status: 200, body: { runId: "run_rec_5xx" } },
        "GET /api/runs/run_rec_5xx/logs": { status: 200, body: [] },
        "GET /api/runs/run_rec_5xx": [
          // First poll fails — the runner must NOT crash.
          { status: 500, body: { error: "transient" } },
          // Subsequent polls succeed and the run terminates normally.
          { status: 200, body: recordSummary({ id: "run_rec_5xx", status: "success" }) },
        ],
      },
      calls,
    );

    const outcome = await runRemote(
      withCapturedWriters(
        buildBaseOpts({
          fetchImpl,
          // Force a record fetch every tick so the test exercises the
          // retry path within a small number of iterations.
          recordPollEveryNTicks: 1,
        }),
      ),
      new AbortController().signal,
    );
    expect(outcome.status).toBe("success");
    // The transient failure should have surfaced as a stderr warning so
    // the user understands why finalization briefly stalled.
    const stderr = writers.stderr.join("");
    expect(stderr).toMatch(/run record refresh failed/);
  });

  it("still propagates a hard failure on the FINAL post-loop record fetch", async () => {
    // The soft-fail policy applies inside the polling loop only; the
    // final fetch (after a terminal status was observed) is the runner's
    // last chance to read authoritative state, so a failure there must
    // bubble up rather than silently render an incomplete result.
    const calls: FetchCall[] = [];
    let recordCallCount = 0;
    const fetchImpl: typeof fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, headers: {}, body: undefined });
      if (url.endsWith("/run") && method === "POST") {
        return new Response(JSON.stringify({ runId: "run_final_5xx" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/logs")) {
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // First record fetch: terminal success → loop exits.
      // Second record fetch (the post-loop "final" one): hard failure.
      recordCallCount++;
      if (recordCallCount === 1) {
        return new Response(
          JSON.stringify(recordSummary({ id: "run_final_5xx", status: "success" })),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "post-loop blew up" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(
      runRemote(
        withCapturedWriters(buildBaseOpts({ fetchImpl, recordPollEveryNTicks: 1 })),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: "RemoteRunError", status: 500 });
  });
});
