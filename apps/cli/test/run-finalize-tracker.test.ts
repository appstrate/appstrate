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
import {
  emptyRunResult,
  type RunResult,
  type TerminalRunResult,
} from "@appstrate/afps-runtime/runner";
import {
  _attachFinalizeTrackerForTesting as attach,
  _finalizeWithinForTesting as finalizeWithin,
} from "../src/commands/run.ts";

const failedResult = (): TerminalRunResult => ({ ...emptyRunResult(), status: "failed" });

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

  const newSink = (url = server.url) =>
    new HttpSink({ url, finalizeUrl: `${url}/finalize`, runSecret: RUN_SECRET });

  it("reports no finalize before any call", () => {
    expect(attach(newSink())()).toBeNull();
  });

  it("hands back the runner's finalize while it is still in flight", async () => {
    const sink = newSink();
    const finalizeOf = attach(sink);
    const sent = sink.finalize(failedResult());
    expect(finalizeOf()).toBe(sent);
    await sent;
    expect(finalizeOf()).toBe(sent);
  });

  it("forwards the finalize POST to the underlying sink (HTTP request reaches finalizeUrl)", async () => {
    const sink = newSink();
    attach(sink);

    const result: TerminalRunResult = {
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

  it("keeps the first finalize on repeated calls (each call still posts)", async () => {
    // The tracker does not enforce single-call semantics — that's the
    // platform's job (server CAS on `sink_closed_at IS NULL`).
    const sink = newSink();
    const finalizeOf = attach(sink);
    const first = sink.finalize(failedResult());
    await first;
    await sink.finalize(failedResult());
    expect(finalizeOf()).toBe(first);
    expect(server.received.filter((r) => r.url === "/events/finalize")).toHaveLength(2);
  });

  it("finalizeWithin: lets an in-flight finalize that answers within the budget land", async () => {
    const slow = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(100);
        return new Response("ok");
      },
    });
    try {
      const sink = newSink(`http://localhost:${slow.port}/events`);
      const finalizeOf = attach(sink);
      void sink.finalize(failedResult());
      await expect(finalizeWithin(sink, finalizeOf()!, 2_000)).resolves.toBeUndefined();
    } finally {
      slow.stop(true);
    }
  });

  it("finalizeWithin: aborts an in-flight finalize the platform never answers, at the cap", async () => {
    // Without the cap, an unreachable platform would let HttpSink retry for
    // tens of seconds, and its pending fetch would keep the process alive.
    const silent = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const sink = newSink(`http://localhost:${silent.port}/events`);
      const finalizeOf = attach(sink);
      sink.finalize(failedResult()).catch(() => {});
      const start = Date.now();
      await expect(finalizeWithin(sink, finalizeOf()!, 50)).rejects.toThrow(/timed out after 50ms/);
      expect(Date.now() - start).toBeLessThan(500);
    } finally {
      silent.stop(true);
    }
  });

  it("does not interfere with regular event POSTs (handle still works)", async () => {
    const sink = newSink();
    const finalizeOf = attach(sink);

    await sink.handle({
      type: "appstrate.progress",
      timestamp: Date.now(),
      runId: "run_track_test",
      message: "still running",
    });
    expect(finalizeOf()).toBeNull();
    const eventPosts = server.received.filter((r) => r.url === "/events");
    expect(eventPosts).toHaveLength(1);
  });
});
