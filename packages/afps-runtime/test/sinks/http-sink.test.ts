// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HttpSink } from "../../src/sinks/http-sink.ts";
import { verify } from "../../src/events/signing.ts";
import type { RunEvent } from "../../src/types/run-event.ts";
import type { RunResult } from "../../src/types/run-result.ts";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface ServerContext {
  url: string;
  finalizeUrl: string;
  received: CapturedRequest[];
  shutdown: () => void;
  /** When non-zero, the N first requests fail with this status. */
  setTransientFailures: (n: number, status: number) => void;
}

function startTestServer(): ServerContext {
  const received: CapturedRequest[] = [];
  let failuresRemaining = 0;
  let failureStatus = 500;

  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = await req.text();
      received.push({
        url: url.pathname,
        method: req.method,
        headers: Object.fromEntries(req.headers as unknown as Iterable<[string, string]>),
        body,
      });
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        return new Response("fail", { status: failureStatus });
      }
      return new Response("ok", { status: 200 });
    },
  });

  const port = server.port;
  return {
    url: `http://localhost:${port}/events`,
    finalizeUrl: `http://localhost:${port}/events/finalize`,
    received,
    shutdown: () => server.stop(true),
    setTransientFailures: (n: number, status: number) => {
      failuresRemaining = n;
      failureStatus = status;
    },
  };
}

const RUN_SECRET = "test-secret-k9rdqs";
const SAMPLE_EVENT: RunEvent = {
  type: "memory.added",
  timestamp: 1714000000000,
  runId: "run_http_test",
  content: "sent via http sink",
};
const SAMPLE_RESULT: RunResult = {
  memories: [{ content: "sent via http sink" }],
  state: null,
  output: null,
  report: null,
  logs: [],
};

describe("HttpSink", () => {
  let server: ServerContext;

  beforeEach(() => {
    server = startTestServer();
  });

  afterEach(() => {
    server.shutdown();
  });

  it("posts a signed CloudEvent for each event", async () => {
    const sink = new HttpSink({
      url: server.url,
      runSecret: RUN_SECRET,
      generateId: () => "id_0001",
      now: () => 1714000000000,
    });

    await sink.handle(SAMPLE_EVENT);

    expect(server.received).toHaveLength(1);
    const req = server.received[0]!;
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toBe("application/cloudevents+json");
    expect(req.headers["webhook-id"]).toBe("id_0001");
    expect(req.headers["webhook-timestamp"]).toBe("1714000000");

    const verified = verify({
      msgId: req.headers["webhook-id"]!,
      timestampSec: parseInt(req.headers["webhook-timestamp"]!, 10),
      body: req.body,
      secret: RUN_SECRET,
      signatureHeader: req.headers["webhook-signature"]!,
      nowSec: 1714000000,
    });
    expect(verified).toEqual({ ok: true });

    const cloudEvent = JSON.parse(req.body);
    expect(cloudEvent.specversion).toBe("1.0");
    expect(cloudEvent.type).toBe("memory.added");
    expect(cloudEvent.source).toBe("/afps/runs/run_http_test");
    expect(cloudEvent.id).toBe("id_0001");
    expect(cloudEvent.sequence).toBe(0);
    expect(cloudEvent.data).toEqual({ content: "sent via http sink" });
  });

  it("increments the sequence extension monotonically across events", async () => {
    const sink = new HttpSink({
      url: server.url,
      runSecret: RUN_SECRET,
      generateId: () => "id",
      now: () => 1714000000000,
    });

    await sink.handle(SAMPLE_EVENT);
    await sink.handle({ ...SAMPLE_EVENT, content: "second" });
    await sink.handle({ ...SAMPLE_EVENT, content: "third" });

    expect(server.received).toHaveLength(3);
    expect(JSON.parse(server.received[0]!.body).sequence).toBe(0);
    expect(JSON.parse(server.received[1]!.body).sequence).toBe(1);
    expect(JSON.parse(server.received[2]!.body).sequence).toBe(2);
  });

  it("forwards third-party event types verbatim as the CloudEvent type", async () => {
    const sink = new HttpSink({
      url: server.url,
      runSecret: RUN_SECRET,
      generateId: () => "id",
      now: () => 1714000000000,
    });

    await sink.handle({
      type: "@my-org/audit.logged",
      timestamp: 1714000000000,
      runId: "run_x",
      actor: "u_1",
    });

    const cloudEvent = JSON.parse(server.received[0]!.body);
    expect(cloudEvent.type).toBe("@my-org/audit.logged");
    expect(cloudEvent.data).toEqual({ actor: "u_1" });
  });

  it("posts the aggregated result to the finalize URL", async () => {
    const sink = new HttpSink({
      url: server.url,
      runSecret: RUN_SECRET,
      generateId: () => "id_final",
      now: () => 1714000000000,
    });

    await sink.finalize(SAMPLE_RESULT);

    expect(server.received).toHaveLength(1);
    const req = server.received[0]!;
    expect(req.url).toBe("/events/finalize");
    expect(JSON.parse(req.body)).toEqual(SAMPLE_RESULT);
  });

  it("retries transient 5xx errors with exponential backoff", async () => {
    server.setTransientFailures(2, 503);

    const sink = new HttpSink({
      url: server.url,
      runSecret: RUN_SECRET,
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      maxAttempts: 4,
    });

    await sink.handle(SAMPLE_EVENT);

    expect(server.received).toHaveLength(3); // 2 failures + 1 success
  });

  it("retries 429 rate-limit responses", async () => {
    server.setTransientFailures(1, 429);

    const sink = new HttpSink({
      url: server.url,
      runSecret: RUN_SECRET,
      initialBackoffMs: 5,
      maxAttempts: 3,
    });

    await sink.handle(SAMPLE_EVENT);

    expect(server.received).toHaveLength(2);
  });

  it("does NOT retry on non-429 4xx errors", async () => {
    server.setTransientFailures(5, 400);

    const sink = new HttpSink({
      url: server.url,
      runSecret: RUN_SECRET,
      initialBackoffMs: 5,
      maxAttempts: 4,
    });

    await expect(sink.handle(SAMPLE_EVENT)).rejects.toThrow(/non-retryable 400/);
    expect(server.received).toHaveLength(1);
  });

  it("throws after exhausting all attempts", async () => {
    server.setTransientFailures(10, 500);

    const sink = new HttpSink({
      url: server.url,
      runSecret: RUN_SECRET,
      initialBackoffMs: 5,
      maxAttempts: 2,
    });

    await expect(sink.handle(SAMPLE_EVENT)).rejects.toThrow(/retryable 500/);
    expect(server.received).toHaveLength(2);
  });

  it("derives the finalize URL from the main URL by default", async () => {
    const sink = new HttpSink({
      url: server.url,
      runSecret: RUN_SECRET,
    });

    await sink.handle(SAMPLE_EVENT);
    await sink.finalize(SAMPLE_RESULT);

    expect(server.received[0]!.url).toBe("/events");
    expect(server.received[1]!.url).toBe("/events/finalize");
  });

  it("honors an explicit finalizeUrl override", async () => {
    const sink = new HttpSink({
      url: server.url,
      finalizeUrl: `${new URL(server.url).origin}/custom-done`,
      runSecret: RUN_SECRET,
    });

    await sink.finalize(SAMPLE_RESULT);
    expect(server.received[0]!.url).toBe("/custom-done");
  });
});
