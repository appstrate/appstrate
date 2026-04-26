// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the CLI's `wrapHttpSinkWithFinalizeTracker` helper — the
 * safety net that lets the run command detect whether `PiRunner`
 * already finalized the sink, so the `finally` block on Ctrl-C /
 * SIGTERM doesn't double-post a `cancelled` finalize on top of a real
 * terminal status.
 *
 * The wrapper is the linchpin of the cooperative-shutdown fast path:
 * without it the platform would have to wait the full
 * `RUN_STALL_THRESHOLD_SECONDS` (60s) for the watchdog to notice a
 * dead CLI. With it, the CLI sends an explicit finalize the moment
 * the user hits Ctrl-C, and the run terminates instantly.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HttpSink } from "@appstrate/afps-runtime/sinks";
import type { RunResult } from "@appstrate/afps-runtime/runner";
import { _wrapHttpSinkWithFinalizeTrackerForTesting as wrap } from "../src/commands/run.ts";

interface CapturedRequest {
  url: string;
  method: string;
  body: string;
}

interface TestServer {
  url: string;
  finalizeUrl: string;
  received: CapturedRequest[];
  shutdown: () => void;
}

function startTestServer(): TestServer {
  const received: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      received.push({ url: url.pathname, method: req.method, body: await req.text() });
      return new Response("ok", { status: 200 });
    },
  });
  return {
    url: `http://localhost:${server.port}/events`,
    finalizeUrl: `http://localhost:${server.port}/events/finalize`,
    received,
    shutdown: () => server.stop(true),
  };
}

const RUN_SECRET = "test-secret-finalize-tracker";

function emptyResult(): RunResult {
  return { memories: [], output: null, report: null, logs: [] };
}

describe("wrapHttpSinkWithFinalizeTracker", () => {
  let server: TestServer;

  beforeEach(() => {
    server = startTestServer();
  });

  afterEach(() => {
    server.shutdown();
  });

  it("reports wasFinalized() === false before any finalize call", () => {
    const inner = new HttpSink({
      url: server.url,
      finalizeUrl: server.finalizeUrl,
      runSecret: RUN_SECRET,
    });
    const tracked = wrap(inner);
    expect(tracked.wasFinalized()).toBe(false);
  });

  it("flips wasFinalized() to true after the wrapped sink finalises", async () => {
    const inner = new HttpSink({
      url: server.url,
      finalizeUrl: server.finalizeUrl,
      runSecret: RUN_SECRET,
    });
    const tracked = wrap(inner);

    expect(tracked.wasFinalized()).toBe(false);
    await tracked.sink.finalize(emptyResult());
    expect(tracked.wasFinalized()).toBe(true);
  });

  it("forwards the finalize POST to the underlying sink (HTTP request reaches finalizeUrl)", async () => {
    const inner = new HttpSink({
      url: server.url,
      finalizeUrl: server.finalizeUrl,
      runSecret: RUN_SECRET,
    });
    const tracked = wrap(inner);

    const result: RunResult = {
      memories: [],
      output: null,
      report: null,
      logs: [],
      status: "cancelled",
      error: { message: "Runner cancelled by user (CLI received signal)." },
    };
    await tracked.sink.finalize(result);

    const finalizePosts = server.received.filter((r) => r.url === "/events/finalize");
    expect(finalizePosts).toHaveLength(1);
    expect(finalizePosts[0]!.method).toBe("POST");
    const body = JSON.parse(finalizePosts[0]!.body) as RunResult;
    expect(body.status).toBe("cancelled");
    expect(body.error?.message).toContain("cancelled by user");
  });

  it("counts a single finalize even when called twice (each call still posts, but the flag stays true)", async () => {
    // Belt-and-suspenders behaviour: the wrapper does not enforce
    // single-call semantics — that's the platform's job (server CAS on
    // `sink_closed_at IS NULL`). The wrapper only tracks "has finalize
    // been observed at least once". Double-finalize from the runner
    // would be a runner bug, not something the wrapper needs to mask.
    const inner = new HttpSink({
      url: server.url,
      finalizeUrl: server.finalizeUrl,
      runSecret: RUN_SECRET,
    });
    const tracked = wrap(inner);
    await tracked.sink.finalize(emptyResult());
    expect(tracked.wasFinalized()).toBe(true);
    await tracked.sink.finalize(emptyResult());
    expect(tracked.wasFinalized()).toBe(true);
    expect(server.received.filter((r) => r.url === "/events/finalize")).toHaveLength(2);
  });

  it("does not interfere with regular event POSTs (handle still works)", async () => {
    const inner = new HttpSink({
      url: server.url,
      finalizeUrl: server.finalizeUrl,
      runSecret: RUN_SECRET,
    });
    const tracked = wrap(inner);

    await tracked.sink.handle({
      type: "appstrate.progress",
      timestamp: Date.now(),
      runId: "run_track_test",
      message: "still running",
    });
    expect(tracked.wasFinalized()).toBe(false);
    const eventPosts = server.received.filter((r) => r.url === "/events");
    expect(eventPosts).toHaveLength(1);
  });
});
