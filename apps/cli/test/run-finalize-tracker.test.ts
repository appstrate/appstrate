// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the CLI's `attachFinalizeTracker` helper — the safety net
 * that lets the run command detect whether `PiRunner` already
 * finalized the sink, so the `finally` block on Ctrl-C / SIGTERM
 * doesn't double-post a `cancelled` finalize on top of a real terminal
 * status.
 *
 * The tracker is the linchpin of the cooperative-shutdown fast path:
 * without it the platform would have to wait the full
 * `RUN_STALL_THRESHOLD_SECONDS` (60s) for the watchdog to notice a
 * dead CLI. With it, the CLI sends an explicit finalize the moment
 * the user hits Ctrl-C, and the run terminates instantly.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HttpSink } from "@appstrate/afps-runtime/sinks";
import { emptyRunResult, type RunResult } from "@appstrate/afps-runtime/runner";
import {
  _attachFinalizeTrackerForTesting as attach,
  _raceFinalizeAgainstTimeoutForTesting as raceTimeout,
} from "../src/commands/run.ts";

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

describe("attachFinalizeTracker", () => {
  let server: TestServer;

  beforeEach(() => {
    server = startTestServer();
  });

  afterEach(() => {
    server.shutdown();
  });

  it("reports false before any finalize call", () => {
    const sink = new HttpSink({
      url: server.url,
      finalizeUrl: server.finalizeUrl,
      runSecret: RUN_SECRET,
    });
    const wasFinalized = attach(sink);
    expect(wasFinalized()).toBe(false);
  });

  it("flips to true after the patched sink finalises", async () => {
    const sink = new HttpSink({
      url: server.url,
      finalizeUrl: server.finalizeUrl,
      runSecret: RUN_SECRET,
    });
    const wasFinalized = attach(sink);

    expect(wasFinalized()).toBe(false);
    await sink.finalize(emptyRunResult());
    expect(wasFinalized()).toBe(true);
  });

  it("forwards the finalize POST to the underlying sink (HTTP request reaches finalizeUrl)", async () => {
    const sink = new HttpSink({
      url: server.url,
      finalizeUrl: server.finalizeUrl,
      runSecret: RUN_SECRET,
    });
    attach(sink);

    const result: RunResult = {
      ...emptyRunResult(),
      status: "cancelled",
      error: { message: "Runner cancelled by user (CLI received signal)." },
    };
    await sink.finalize(result);

    const finalizePosts = server.received.filter((r) => r.url === "/events/finalize");
    expect(finalizePosts).toHaveLength(1);
    expect(finalizePosts[0]!.method).toBe("POST");
    const body = JSON.parse(finalizePosts[0]!.body) as RunResult;
    expect(body.status).toBe("cancelled");
    expect(body.error?.message).toContain("cancelled by user");
  });

  it("stays true on repeated finalize calls (each call still posts, flag stays true)", async () => {
    // Belt-and-suspenders behaviour: the tracker does not enforce
    // single-call semantics — that's the platform's job (server CAS on
    // `sink_closed_at IS NULL`). The tracker only records "has finalize
    // been observed at least once". Double-finalize from the runner
    // would be a runner bug, not something the tracker needs to mask.
    const sink = new HttpSink({
      url: server.url,
      finalizeUrl: server.finalizeUrl,
      runSecret: RUN_SECRET,
    });
    const wasFinalized = attach(sink);
    await sink.finalize(emptyRunResult());
    expect(wasFinalized()).toBe(true);
    await sink.finalize(emptyRunResult());
    expect(wasFinalized()).toBe(true);
    expect(server.received.filter((r) => r.url === "/events/finalize")).toHaveLength(2);
  });

  it("raceFinalizeAgainstTimeout: rejects with a clear error if the inner promise outlasts the cap", async () => {
    // Without the timeout cap, an unreachable platform would let
    // HttpSink retry for tens of seconds — exactly the UX problem the
    // safety-net is trying to eliminate. The cap MUST fire even if the
    // inner promise never settles.
    const slow = new Promise<void>(() => {
      // never resolves — simulates a partitioned platform
    });
    const start = Date.now();
    await expect(raceTimeout(slow, 50)).rejects.toThrow(/timed out after 50ms/);
    const elapsed = Date.now() - start;
    // 50ms cap + small scheduler slack — must NOT take seconds.
    expect(elapsed).toBeLessThan(500);
  });

  it("raceFinalizeAgainstTimeout: resolves normally when the inner promise wins the race", async () => {
    const fast = Promise.resolve();
    await expect(raceTimeout(fast, 5_000)).resolves.toBeUndefined();
  });

  it("raceFinalizeAgainstTimeout: surfaces inner rejection when it wins the race", async () => {
    const failing = Promise.reject(new Error("boom"));
    await expect(raceTimeout(failing, 5_000)).rejects.toThrow("boom");
  });

  it("does not interfere with regular event POSTs (handle still works)", async () => {
    const sink = new HttpSink({
      url: server.url,
      finalizeUrl: server.finalizeUrl,
      runSecret: RUN_SECRET,
    });
    const wasFinalized = attach(sink);

    await sink.handle({
      type: "appstrate.progress",
      timestamp: Date.now(),
      runId: "run_track_test",
      message: "still running",
    });
    expect(wasFinalized()).toBe(false);
    const eventPosts = server.received.filter((r) => r.url === "/events");
    expect(eventPosts).toHaveLength(1);
  });
});
