// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `firecracker` backend's remote orchestrator (the
 * HTTP client of the appstrate-runner daemon) — NO network:
 * every test injects a `fetchFn` returning canned Response objects and
 * asserts the wire shapes against the frozen protocol schemas, so a
 * client-side drift from `runner/protocol.ts` fails here, not against a
 * live daemon.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { RemoteFirecrackerOrchestrator } from "../../remote-orchestrator.ts";
import { _resetRemoteEnvCacheForTesting } from "../../remote-env.ts";
import {
  RUNNER_ROUTES,
  RUNNER_PROTOCOL_VERSION,
  createBoundaryBodySchema,
} from "../../runner/protocol.ts";
import type { IsolationBoundary, WorkloadHandle } from "@appstrate/core/platform-types";

// Loopback on purpose: the P1-5 transport gate refuses plaintext http://
// to a NON-loopback daemon at env parse time; these tests exercise the
// protocol wire shapes, not the gate (covered by remote-env.test.ts).
const BASE_URL = "http://127.0.0.1:8811";
const TOKEN = "unit-test-token-0123456789";
const ENV_KEYS = ["FIRECRACKER_RUNNER_URL", "FIRECRACKER_RUNNER_TOKEN"] as const;

const HANDLE: WorkloadHandle = { id: "w-1", runId: "r-1", role: "agent" };

const BOUNDARY: IsolationBoundary = {
  id: "fc-r-1",
  name: "appstrate-run-r-1",
  workspace: { kind: "directory", path: "/workspace" },
  sidecarEndpoints: {
    sidecarUrl: "http://127.0.0.1:8080",
    llmProxyUrl: "http://127.0.0.1:8081",
    forwardProxyUrl: "http://127.0.0.1:8082",
    noProxy: "localhost,127.0.0.1",
  },
};

const HEALTH_OK = {
  ok: true,
  adapter: "firecracker",
  protocol: RUNNER_PROTOCOL_VERSION,
  initialized: true,
  platformUrl: "http://10.0.0.9:3000",
  platformReachable: true,
  guestPathVerified: true,
};

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

/** Canned-response fetch stub recording every call. */
function fetchStub(
  responder: (url: string, init: RequestInit | undefined, index: number) => Response,
): { fn: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const index = calls.length;
    calls.push({ url: String(input), init });
    return responder(String(input), init, index);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(call: RecordedCall): unknown {
  return JSON.parse(String(call.init?.body));
}

function authHeaderOf(call: RecordedCall): string | undefined {
  return (call.init?.headers as Record<string, string> | undefined)?.authorization;
}

function unixOf(call: RecordedCall): string | undefined {
  return (call.init as { unix?: string } | undefined)?.unix;
}

function ndjsonBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++] as string));
      else controller.close();
    },
  });
}

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // Trailing slash on purpose: the env getter must strip it.
  process.env.FIRECRACKER_RUNNER_URL = `${BASE_URL}/`;
  process.env.FIRECRACKER_RUNNER_TOKEN = TOKEN;
  _resetRemoteEnvCacheForTesting();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetRemoteEnvCacheForTesting();
});

describe("RemoteFirecrackerOrchestrator.initialize", () => {
  it("handshakes with the daemon (GET health, bearer auth, trailing slash stripped)", async () => {
    const { fn, calls } = fetchStub(() => json(HEALTH_OK));
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn });

    await orchestrator.initialize();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE_URL}${RUNNER_ROUTES.health}`);
    expect(calls[0]?.init?.method).toBe("GET");
    expect(authHeaderOf(calls[0] as RecordedCall)).toBe(`Bearer ${TOKEN}`);
  });

  it("fails with an actionable message when the env vars are missing", async () => {
    delete process.env.FIRECRACKER_RUNNER_URL;
    delete process.env.FIRECRACKER_RUNNER_TOKEN;
    _resetRemoteEnvCacheForTesting();
    const { fn, calls } = fetchStub(() => json(HEALTH_OK));
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn });

    const error = await orchestrator.initialize().then(
      () => undefined,
      (err: unknown) => err as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("FIRECRACKER_RUNNER_URL");
    expect(error?.message).toContain("FIRECRACKER_RUNNER_TOKEN");
    expect(error?.message).toContain("README");
    expect(calls).toHaveLength(0);
  });

  it("rejects a daemon speaking a different protocol version", async () => {
    const { fn } = fetchStub(() => json({ ...HEALTH_OK, protocol: RUNNER_PROTOCOL_VERSION + 1 }));
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn });

    const error = await orchestrator.initialize().then(
      () => undefined,
      (err: unknown) => err as Error,
    );

    expect(error?.message).toContain(`speaks protocol ${RUNNER_PROTOCOL_VERSION + 1}`);
    expect(error?.message).toContain(`expects ${RUNNER_PROTOCOL_VERSION}`);
    expect(error?.message).toContain("upgrade the older side");
  });

  it("names the daemon URL when the request itself fails", async () => {
    const fn = (async () => {
      throw new TypeError("Unable to connect");
    }) as unknown as typeof fetch;
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn });

    const error = await orchestrator.initialize().then(
      () => undefined,
      (err: unknown) => err as Error,
    );

    expect(error?.message).toContain(BASE_URL);
    expect(error?.message).toContain("running and reachable");
  });

  it("surfaces the daemon's error body on a non-2xx health response", async () => {
    const { fn } = fetchStub(() => json({ error: "kvm unavailable" }, 500));
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn });

    const error = await orchestrator.initialize().then(
      () => undefined,
      (err: unknown) => err as Error,
    );

    expect(error?.message).toContain(RUNNER_ROUTES.health);
    expect(error?.message).toContain("kvm unavailable");
  });

  it("rejects a daemon whose orchestrator is not initialized", async () => {
    const { fn } = fetchStub(() => json({ ...HEALTH_OK, initialized: false }));
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn });

    const error = await orchestrator.initialize().then(
      () => undefined,
      (err: unknown) => err as Error,
    );

    expect(error?.message).toContain("failed to initialize");
  });
});

describe("RemoteFirecrackerOrchestrator boundary calls", () => {
  it("createIsolationBoundary sends a protocol-conformant body and returns the boundary verbatim", async () => {
    const { fn, calls } = fetchStub(() => json(BOUNDARY));
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn });

    const requirements = {
      capabilities: [{ kind: "browser" as const, profile: "standard" as const, instances: 1 }],
      supplementalResources: {
        memoryBytes: 1_073_741_824,
        nanoCpus: 1_000_000_000,
        pidsLimit: 256,
      },
    };
    const boundary = await orchestrator.createIsolationBoundary("r-1", {
      skipSidecar: true,
      requirements,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE_URL}${RUNNER_ROUTES.createBoundary}`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(authHeaderOf(calls[0] as RecordedCall)).toBe(`Bearer ${TOKEN}`);
    const parsed = createBoundaryBodySchema.safeParse(bodyOf(calls[0] as RecordedCall));
    expect(parsed.success).toBe(true);
    expect(bodyOf(calls[0] as RecordedCall)).toEqual({
      runId: "r-1",
      opts: { skipSidecar: true, requirements },
    });
    expect(boundary).toEqual(BOUNDARY);
  });

  it("maps a non-2xx { error } body to a thrown error naming the route", async () => {
    const { fn } = fetchStub(() => json({ error: "boom" }, 500));
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn });

    const error = await orchestrator.startWorkload(HANDLE).then(
      () => undefined,
      (err: unknown) => err as Error,
    );

    expect(error?.message).toContain("boom");
    expect(error?.message).toContain(RUNNER_ROUTES.startWorkload);
  });
});

describe("RemoteFirecrackerOrchestrator.waitForExit", () => {
  it("long-polls until { done: true } and returns the exit code", async () => {
    const { fn, calls } = fetchStub((_url, _init, index) =>
      index === 0 ? json({ done: false }) : json({ done: true, code: 42 }),
    );
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn });

    const code = await orchestrator.waitForExit(HANDLE);

    expect(code).toBe(42);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(`${BASE_URL}${RUNNER_ROUTES.waitForExit}`);
    expect(bodyOf(calls[0] as RecordedCall)).toEqual({ handle: HANDLE });
  });

  it("survives a network error with a retry (the run outcome must outlive a daemon blip)", async () => {
    let attempts = 0;
    const fn = (async (input: string | URL) => {
      attempts += 1;
      if (attempts === 1) throw new TypeError(`Unable to connect to ${String(input)}`);
      return json({ done: true, code: 0 });
    }) as unknown as typeof fetch;
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn, retryBaseMs: 1 });

    const code = await orchestrator.waitForExit(HANDLE);

    expect(code).toBe(0);
    expect(attempts).toBe(2);
  });
});

describe("RemoteFirecrackerOrchestrator.streamLogs", () => {
  it("reassembles NDJSON lines split across chunk boundaries", async () => {
    const { fn, calls } = fetchStub(
      () =>
        new Response(
          ndjsonBody(['{"line":"alpha"}\n{"li', 'ne":"beta"}\n{"line":"g', 'amma"}\n']),
          { status: 200 },
        ),
    );
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn });

    const lines: string[] = [];
    for await (const line of orchestrator.streamLogs(HANDLE)) lines.push(line);

    expect(lines).toEqual(["alpha", "beta", "gamma"]);
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0] as RecordedCall)).toEqual({ handle: HANDLE, skip: 0 });
  });

  it("reconnects after a mid-stream error, skipping the lines already received", async () => {
    const encoder = new TextEncoder();
    const { fn, calls } = fetchStub((_url, _init, index) => {
      if (index === 0) {
        // Deliver one full line, then break the stream on the NEXT pull —
        // erroring inside start() would discard the still-queued chunk.
        let pulls = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) controller.enqueue(encoder.encode('{"line":"one"}\n'));
              else controller.error(new Error("connection reset"));
            },
          }),
          { status: 200 },
        );
      }
      return new Response(ndjsonBody(['{"line":"two"}\n']), { status: 200 });
    });
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn, retryBaseMs: 1 });

    const lines: string[] = [];
    for await (const line of orchestrator.streamLogs(HANDLE)) lines.push(line);

    expect(lines).toEqual(["one", "two"]);
    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[0] as RecordedCall)).toEqual({ handle: HANDLE, skip: 0 });
    expect(bodyOf(calls[1] as RecordedCall)).toEqual({ handle: HANDLE, skip: 1 });
  });

  it("ends without reconnecting when the abort signal fires", async () => {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const { fn, calls } = fetchStub(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              controller.enqueue(encoder.encode('{"line":"only"}\n'));
            },
          }),
          { status: 200 },
        ),
    );
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn, retryBaseMs: 1 });
    const abort = new AbortController();

    const generator = orchestrator.streamLogs(HANDLE, abort.signal);
    const first = await generator.next();
    expect(first.done).toBe(false);
    expect(first.value).toBe("only");

    // Abort, then fail the in-flight read the way a real aborted fetch does.
    abort.abort();
    streamController?.error(new DOMException("The operation was aborted.", "AbortError"));

    const end = await generator.next();
    expect(end.done).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("RemoteFirecrackerOrchestrator UDS transport", () => {
  const SOCKET = "/run/appstrate-runner/runner.sock";

  it("dials the socket via init.unix with a fixed http base (authority ignored over UDS)", async () => {
    process.env.FIRECRACKER_RUNNER_URL = `unix://${SOCKET}`;
    _resetRemoteEnvCacheForTesting();
    const { fn, calls } = fetchStub(() => json({}));
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn });

    await orchestrator.startWorkload(HANDLE);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://appstrate-runner${RUNNER_ROUTES.startWorkload}`);
    expect(unixOf(calls[0] as RecordedCall)).toBe(SOCKET);
    // Bearer auth is unchanged over UDS — the socket mode is
    // defense-in-depth, not a substitute for the token.
    expect(authHeaderOf(calls[0] as RecordedCall)).toBe(`Bearer ${TOKEN}`);
  });

  it("keeps init.unix undefined over a TCP (https) runner URL", async () => {
    process.env.FIRECRACKER_RUNNER_URL = "https://runner.internal:3100";
    _resetRemoteEnvCacheForTesting();
    const { fn, calls } = fetchStub(() => json({}));
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn });

    await orchestrator.startWorkload(HANDLE);

    expect(calls[0]?.url).toBe(`https://runner.internal:3100${RUNNER_ROUTES.startWorkload}`);
    expect(unixOf(calls[0] as RecordedCall)).toBeUndefined();
    expect(calls[0]?.init && "unix" in calls[0].init).toBe(false);
  });

  it("keeps error messages readable with the unix:// URL when the socket is unreachable", async () => {
    process.env.FIRECRACKER_RUNNER_URL = `unix://${SOCKET}`;
    _resetRemoteEnvCacheForTesting();
    const fn = (async () => {
      throw new TypeError("Unable to connect");
    }) as unknown as typeof fetch;
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn });

    const error = await orchestrator.startWorkload(HANDLE).then(
      () => undefined,
      (err: unknown) => err as Error,
    );

    // The operator-facing message interpolates the env URL — a unix://
    // path names the socket, which is exactly "which daemon?".
    expect(error?.message).toContain(`unix://${SOCKET}`);
    expect(error?.message).toContain("running and reachable");
  });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("RemoteFirecrackerOrchestrator boot-phase heartbeat", () => {
  it("synthesises heartbeats while the guest is silent, and stops once it becomes active", async () => {
    let hbCalls = 0;
    const recordBootHeartbeat = () => {
      hbCalls += 1;
      // First two ticks: still booting. Third: guest is now reporting.
      return Promise.resolve(hbCalls < 3 ? ("bumped" as const) : ("guest-active" as const));
    };
    const fn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes(RUNNER_ROUTES.workloadStatus)) return json({ running: true });
      if (url.includes(RUNNER_ROUTES.waitForExit)) {
        await sleep(80); // outlives the pump so the "stop on guest-active" is observed
        return json({ done: true, code: 0 });
      }
      return json({});
    }) as unknown as typeof fetch;

    const orchestrator = new RemoteFirecrackerOrchestrator({
      fetchFn: fn,
      recordBootHeartbeat,
      heartbeatIntervalMs: 5,
    });

    const code = await orchestrator.waitForExit(HANDLE);
    expect(code).toBe(0);
    // The pump stopped itself at the guest-active tick — never beats again.
    expect(hbCalls).toBe(3);
  });

  it("does NOT heartbeat while the daemon reports the VMM dead (never masks a dead VM)", async () => {
    let hbCalls = 0;
    const recordBootHeartbeat = () => {
      hbCalls += 1;
      return Promise.resolve("bumped" as const);
    };
    const fn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes(RUNNER_ROUTES.workloadStatus)) return json({ running: false });
      if (url.includes(RUNNER_ROUTES.waitForExit)) {
        await sleep(40);
        return json({ done: true, code: 1 });
      }
      return json({});
    }) as unknown as typeof fetch;

    const orchestrator = new RemoteFirecrackerOrchestrator({
      fetchFn: fn,
      recordBootHeartbeat,
      heartbeatIntervalMs: 5,
    });

    await orchestrator.waitForExit(HANDLE);
    expect(hbCalls).toBe(0);
  });

  it("is inert when no heartbeat recorder is wired (no status probes at all)", async () => {
    const { fn, calls } = fetchStub((url) =>
      url.includes(RUNNER_ROUTES.waitForExit) ? json({ done: true, code: 0 }) : json({}),
    );
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn, heartbeatIntervalMs: 1 });

    await orchestrator.waitForExit(HANDLE);
    // Only the exit poll crossed the wire — no workloadStatus probe.
    expect(calls.every((c) => !c.url.includes(RUNNER_ROUTES.workloadStatus))).toBe(true);
  });
});

describe("RemoteFirecrackerOrchestrator abnormal-exit console capture", () => {
  it("fetches and records the console tail on a non-zero exit", async () => {
    const recorded: Array<[string, number, string]> = [];
    const fn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes(RUNNER_ROUTES.waitForExit)) return json({ done: true, code: 137 });
      if (url.includes("/console")) return new Response("panic: guest died\n", { status: 200 });
      return json({});
    }) as unknown as typeof fetch;

    const orchestrator = new RemoteFirecrackerOrchestrator({
      fetchFn: fn,
      recordConsoleExcerpt: (runId, exitCode, excerpt) => {
        recorded.push([runId, exitCode, excerpt]);
        return Promise.resolve();
      },
    });

    const code = await orchestrator.waitForExit(HANDLE);
    expect(code).toBe(137);
    expect(recorded).toEqual([["r-1", 137, "panic: guest died\n"]]);
  });

  it("does not capture on a clean exit, and never fails finalize when the fetch errors", async () => {
    let recorded = 0;
    const fn = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(RUNNER_ROUTES.waitForExit)) return json({ done: true, code: 0 });
      if (url.includes("/console")) throw new TypeError("console fetch failed");
      void init;
      return json({});
    }) as unknown as typeof fetch;

    const orchestrator = new RemoteFirecrackerOrchestrator({
      fetchFn: fn,
      recordConsoleExcerpt: () => {
        recorded += 1;
        return Promise.resolve();
      },
    });

    // Clean exit → no capture attempt.
    expect(await orchestrator.waitForExit(HANDLE)).toBe(0);
    expect(recorded).toBe(0);
  });

  it("swallows a console-fetch failure on an abnormal exit (finalize still gets the code)", async () => {
    let recorded = 0;
    const fn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes(RUNNER_ROUTES.waitForExit)) return json({ done: true, code: 1 });
      if (url.includes("/console")) throw new TypeError("console fetch failed");
      return json({});
    }) as unknown as typeof fetch;

    const orchestrator = new RemoteFirecrackerOrchestrator({
      fetchFn: fn,
      recordConsoleExcerpt: () => {
        recorded += 1;
        return Promise.resolve();
      },
    });

    // The excerpt fetch fails, but the exit code is still returned intact.
    expect(await orchestrator.waitForExit(HANDLE)).toBe(1);
    expect(recorded).toBe(0);
  });
});

describe("RemoteFirecrackerOrchestrator misc calls", () => {
  it("stopByRunId passes the daemon's result through", async () => {
    const { fn, calls } = fetchStub(() => json({ result: "already_stopped" }));
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn });

    const result = await orchestrator.stopByRunId("r-1", 5);

    expect(result).toBe("already_stopped");
    expect(calls[0]?.url).toBe(`${BASE_URL}${RUNNER_ROUTES.stopRun}`);
    expect(bodyOf(calls[0] as RecordedCall)).toEqual({ runId: "r-1", timeoutSeconds: 5 });
  });

  it("cleanupOrphans is a no-op that resolves to zeros WITHOUT any HTTP call", async () => {
    // The daemon owns host reconciliation (it sweeps at its own boot); a
    // platform boot must never reap live microVMs on the runner host. So the
    // client answers zeros locally — a fetch here would be a bug.
    const fn = (async () => {
      throw new Error("cleanupOrphans must not touch the daemon");
    }) as unknown as typeof fetch;
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn });

    expect(await orchestrator.cleanupOrphans()).toEqual({
      workloads: 0,
      isolationBoundaries: 0,
      workspaces: 0,
    });
  });

  it("resolvePlatformApiUrl reads platformUrl from health and caches it (single fetch)", async () => {
    const { fn, calls } = fetchStub(() =>
      json({ ...HEALTH_OK, platformUrl: "http://platform.internal:3000" }),
    );
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn });

    const first = await orchestrator.resolvePlatformApiUrl();
    const second = await orchestrator.resolvePlatformApiUrl();

    expect(first).toBe("http://platform.internal:3000");
    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE_URL}${RUNNER_ROUTES.health}`);
    expect(calls[0]?.init?.method).toBe("GET");
  });

  it("initialize() primes the platform-url cache — resolve makes no extra call", async () => {
    const { fn, calls } = fetchStub(() =>
      json({ ...HEALTH_OK, platformUrl: "http://platform.internal:3000" }),
    );
    const orchestrator = new RemoteFirecrackerOrchestrator({ fetchFn: fn });

    await orchestrator.initialize();
    expect(calls).toHaveLength(1); // just the health handshake

    expect(await orchestrator.resolvePlatformApiUrl()).toBe("http://platform.internal:3000");
    expect(calls).toHaveLength(1); // served from the cached handshake, no second call
  });
});
