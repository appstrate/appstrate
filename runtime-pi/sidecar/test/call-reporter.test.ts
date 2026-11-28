// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import {
  connectionCallJournal,
  createCallReporter,
  type CallReporter,
  type IntegrationCallRecord,
} from "../call-reporter.ts";
import { _setLogSinkForTesting } from "../logger.ts";
import { createTestApp } from "./helpers/authed-app.ts";
import { recordingCallReporter } from "./helpers/call-journal.ts";

const record = (overrides: Partial<IntegrationCallRecord> = {}): IntegrationCallRecord => ({
  call_id: "01900000-0000-7000-8000-000000000000",
  called_at: "2026-03-01T10:00:00.000Z",
  integration_id: "@test/integ",
  connection_id: "11111111-1111-4111-8111-111111111111",
  method: "GET",
  host: "api.example.com",
  outcome: "200",
  duration_ms: 12,
  ...overrides,
});

interface Post {
  url: string;
  authorization: string | null;
  contentType: string | null;
  calls: IntegrationCallRecord[];
}

function platform(
  answer: () => Response | Promise<Response> = () => new Response(null, { status: 204 }),
) {
  const posts: Post[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    posts.push({
      url,
      authorization: headers.get("authorization"),
      contentType: headers.get("content-type"),
      calls: (JSON.parse(String(init.body)) as { calls: IntegrationCallRecord[] }).calls,
    });
    return answer();
  }) as unknown as typeof fetch;
  return { posts, fetchFn };
}

const logs: string[] = [];
const previousLogLevel = process.env.LOG_LEVEL;
afterEach(() => {
  logs.length = 0;
  _setLogSinkForTesting(null);
  if (previousLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = previousLogLevel;
});

describe("createCallReporter", () => {
  it("batches records until the flush interval and POSTs them with the run token", async () => {
    const { posts, fetchFn } = platform();
    const reporter = createCallReporter({
      platformApiUrl: "http://platform/",
      runToken: "run-tok",
      fetchFn,
      flushIntervalMs: 20,
    });
    reporter.report(record());
    reporter.report(record({ outcome: "404" }));
    expect(posts).toEqual([]);
    await new Promise((r) => setTimeout(r, 60));
    expect(posts).toEqual([
      {
        url: "http://platform/internal/integration-calls",
        authorization: "Bearer run-tok",
        contentType: "application/json",
        calls: [record(), record({ outcome: "404" })],
      },
    ]);
  });

  it("sends a flush in batches, and drops what overflows the queue with a logged count", async () => {
    process.env.LOG_LEVEL = "warn";
    _setLogSinkForTesting((_level, line) => logs.push(line));
    const { posts, fetchFn } = platform();
    const reporter = createCallReporter({
      platformApiUrl: "http://platform",
      runToken: "t",
      fetchFn,
      flushIntervalMs: 60_000,
      maxBatch: 2,
    });
    for (let i = 0; i < 12; i++) reporter.report(record());
    expect(posts).toEqual([]);
    await reporter.drain();
    expect(posts.map((p) => p.calls.length)).toEqual([2, 2, 2, 2, 2]);
    expect(logs.join("\n")).toContain("integration call journal full, records dropped");
    expect(logs.join("\n")).toContain('"records":2');
  });

  it("sends one batch at a time, in queue order", async () => {
    let inFlight = 0;
    let most = 0;
    const { posts, fetchFn } = platform(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return new Response(null, { status: 204 });
    });
    const reporter = createCallReporter({
      platformApiUrl: "http://platform",
      runToken: "t",
      fetchFn,
      flushIntervalMs: 60_000,
      maxBatch: 2,
    });
    for (const outcome of ["200", "201", "202", "203", "204"]) reporter.report(record({ outcome }));
    await reporter.drain();
    expect(most).toBe(1);
    expect(posts.map((p) => p.calls.map((c) => c.outcome))).toEqual([
      ["200", "201"],
      ["202", "203"],
      ["204"],
    ]);
  });

  it("sends a streak-ending record at once, with what was queued before it", async () => {
    const { posts, fetchFn } = platform();
    const reporter = createCallReporter({
      platformApiUrl: "http://platform",
      runToken: "t",
      fetchFn,
      flushIntervalMs: 60_000,
    });
    reporter.report(record({ outcome: "401" }));
    reporter.report(record({ credential_revision: "0123456789abcdef" }));
    expect(posts.map((p) => p.calls.map((c) => c.outcome))).toEqual([["401", "200"]]);
    await reporter.drain();
  });

  it("drain sends what is queued and waits for every POST in flight", async () => {
    let release!: () => void;
    const answered = new Promise<void>((r) => (release = r));
    let settled = false;
    const { posts, fetchFn } = platform(async () => {
      await answered;
      settled = true;
      return new Response(null, { status: 204 });
    });
    const reporter = createCallReporter({
      platformApiUrl: "http://platform",
      runToken: "t",
      fetchFn,
      flushIntervalMs: 60_000,
    });
    reporter.report(record());
    const draining = reporter.drain();
    expect(posts).toHaveLength(1);
    expect(settled).toBe(false);
    release();
    await draining;
    expect(settled).toBe(true);
    await reporter.drain();
    expect(posts).toHaveLength(1);
  });

  it("still sends after a drain or flush found nothing queued", async () => {
    const { posts, fetchFn } = platform();
    const reporter = createCallReporter({
      platformApiUrl: "http://platform",
      runToken: "t",
      fetchFn,
      flushIntervalMs: 60_000,
    });
    await reporter.drain();
    reporter.report(record({ credential_revision: "0123456789abcdef" }));
    expect(posts).toHaveLength(1);
    reporter.report(record({ outcome: "404" }));
    await reporter.drain();
    expect(posts.map((p) => p.calls.map((c) => c.outcome))).toEqual([["200"], ["404"]]);
  });

  it("logs and drops a refused or failed batch, never throwing", async () => {
    process.env.LOG_LEVEL = "warn";
    _setLogSinkForTesting((_level, line) => logs.push(line));
    const answers: Array<() => Response> = [
      () => new Response(null, { status: 403 }),
      () => {
        throw new Error("connection refused");
      },
      () => {
        throw new Error("connection refused");
      },
    ];
    const { posts, fetchFn } = platform(() => answers.shift()!());
    const reporter = createCallReporter({
      platformApiUrl: "http://platform",
      runToken: "t",
      fetchFn,
      flushIntervalMs: 60_000,
    });
    reporter.report(record());
    await reporter.drain();
    reporter.report(record());
    await reporter.drain();
    await reporter.drain();
    // A 4xx is final; a transport failure is attempted twice.
    expect(posts).toHaveLength(3);
    expect(logs.join("\n")).toContain("integration call report refused, records dropped");
    expect(logs.join("\n")).toContain("integration call report failed, records dropped");
  });

  it("tells every record of a batch that did not answer 2xx, and none of a delivered one", async () => {
    const answers: Array<() => Response> = [
      () => new Response(null, { status: 204 }),
      () => new Response(null, { status: 429 }),
      () => new Response(null, { status: 503 }),
      () => new Response(null, { status: 503 }),
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 500 }),
    ];
    const { fetchFn } = platform(() => answers.shift()!());
    const reporter = createCallReporter({
      platformApiUrl: "http://platform",
      runToken: "t",
      fetchFn,
      flushIntervalMs: 60_000,
    });
    const undelivered: string[] = [];
    for (const outcome of ["201", "429", "503", "500"]) {
      reporter.report(record({ outcome }), () => undelivered.push(outcome));
      reporter.report(record({ outcome: "404" }));
      await reporter.drain();
    }
    expect(undelivered).toEqual(["429", "503", "500"]);
  });
});

describe("createCallReporter — retry and drain deadline", () => {
  it("retries a failed POST once with the same records, then stops", async () => {
    const answers: Array<() => Response> = [
      () => new Response(null, { status: 502 }),
      () => new Response(null, { status: 204 }),
    ];
    const { posts, fetchFn } = platform(() => answers.shift()!());
    const reporter = createCallReporter({
      platformApiUrl: "http://platform",
      runToken: "t",
      fetchFn,
      flushIntervalMs: 60_000,
    });
    const undelivered: string[] = [];
    reporter.report(record(), () => undelivered.push("lost"));
    await reporter.drain();
    expect(posts.map((p) => p.calls)).toEqual([[record()], [record()]]);
    expect(undelivered).toEqual([]);
  });

  const hangingFetch = ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as unknown as typeof fetch;

  it("gives up at the drain deadline, aborting the POST in flight and counting what it drops", async () => {
    process.env.LOG_LEVEL = "warn";
    _setLogSinkForTesting((_level, line) => logs.push(line));
    const reporter = createCallReporter({
      platformApiUrl: "http://platform",
      runToken: "t",
      fetchFn: hangingFetch,
      flushIntervalMs: 60_000,
      maxBatch: 1,
      drainDeadlineMs: 80,
    });
    const undelivered: string[] = [];
    for (const outcome of ["200", "201", "202"]) {
      reporter.report(record({ outcome }), () => undelivered.push(outcome));
    }
    const started = Date.now();
    await reporter.drain();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(1_000);
    expect(undelivered.sort()).toEqual(["200", "201", "202"]);
    expect(logs.join("\n")).toContain("drain hit its deadline, records dropped");
  });

  it("waits for a POST that lands within the deadline, and gives up on none", async () => {
    process.env.LOG_LEVEL = "warn";
    _setLogSinkForTesting((_level, line) => logs.push(line));
    const { fetchFn } = platform(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return new Response(null, { status: 204 });
    });
    const reporter = createCallReporter({
      platformApiUrl: "http://platform",
      runToken: "t",
      fetchFn,
      flushIntervalMs: 60_000,
      drainDeadlineMs: 2_000,
    });
    const undelivered: string[] = [];
    reporter.report(record(), () => undelivered.push("lost"));
    const started = Date.now();
    await reporter.drain();
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(undelivered).toEqual([]);
    expect(logs.join("\n")).not.toContain("deadline");
  });

  it("overlapping drains share one deadline: the first to return does not unbound the other", async () => {
    const reporter = createCallReporter({
      platformApiUrl: "http://platform",
      runToken: "t",
      fetchFn: hangingFetch,
      flushIntervalMs: 60_000,
      maxBatch: 1,
      drainDeadlineMs: 600,
    });
    reporter.report(record({ outcome: "200" }));
    const started = Date.now();
    const first = reporter.drain();
    await new Promise((r) => setTimeout(r, 400));
    reporter.report(record({ outcome: "201" }));
    await Promise.all([first, reporter.drain()]);
    // The second joined the first's deadline (600 ms from its start), not a fresh one (1000 ms).
    expect(Date.now() - started).toBeLessThan(800);
  });
});

describe("connectionCallJournal", () => {
  const binding = (pending: string | undefined) => {
    const asked: Array<string | undefined> = [];
    const rearmed: string[] = [];
    return {
      asked,
      rearmed,
      source: {
        streakEndingRevision: (revision: string | undefined) => {
          asked.push(revision);
          return pending !== undefined && revision === pending ? revision : undefined;
        },
        streakNotEnded: (revision: string) => {
          rearmed.push(revision);
        },
      },
    };
  };

  it("writes the binding's integration and connection on every record", () => {
    const { reporter, records } = recordingCallReporter();
    const journal = connectionCallJournal(reporter, {
      integrationId: "@test/integ",
      connectionId: null,
      source: null,
    });
    journal({
      method: "PATCH",
      host: "h",
      outcome: "upstream_timeout",
      durationMs: 3.6,
      startedAtMs: Date.parse("2026-03-01T10:00:00.000Z"),
      credential: null,
    });
    expect(records).toEqual([
      {
        call_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
        called_at: "2026-03-01T10:00:00.000Z",
        integration_id: "@test/integ",
        connection_id: null,
        method: "PATCH",
        host: "h",
        outcome: "upstream_timeout",
        duration_ms: 4,
      },
    ]);
  });

  it("stamps a call id of its own and the start the call carries", () => {
    const { reporter, records } = recordingCallReporter();
    const journal = connectionCallJournal(reporter, {
      integrationId: "@test/integ",
      connectionId: null,
      source: null,
    });
    const startedAtMs = Date.parse("2026-03-01T10:00:00.000Z");
    journal({
      method: "GET",
      host: "h",
      outcome: "200",
      durationMs: 1_500,
      startedAtMs,
      credential: null,
    });
    journal({
      method: "GET",
      host: "h",
      outcome: "200",
      durationMs: 0,
      startedAtMs,
      credential: null,
    });

    const [slow, quick] = records;
    expect(slow!.call_id).not.toBe(quick!.call_id);
    expect(slow!.called_at).toBe("2026-03-01T10:00:00.000Z");
  });

  it("asks the source for a streak only on a 2xx answered with the injected credential", () => {
    const { reporter, records } = recordingCallReporter();
    const { asked, source } = binding("0123456789abcdef");
    const journal = connectionCallJournal(reporter, {
      integrationId: "@test/integ",
      connectionId: "conn-a",
      source,
    });
    const credential = { revision: "0123456789abcdef" };
    journal({
      method: "GET",
      host: "h",
      outcome: "401",
      durationMs: 1,
      startedAtMs: Date.now(),
      credential,
    });
    journal({
      method: "GET",
      host: "h",
      outcome: "200",
      durationMs: 1,
      startedAtMs: Date.now(),
      credential: null,
    });
    journal({
      method: "GET",
      host: "h",
      outcome: "204",
      durationMs: 1,
      startedAtMs: Date.now(),
      credential,
    });
    expect(asked).toEqual(["0123456789abcdef"]);
    expect(records.map((r) => r.credential_revision)).toEqual([
      undefined,
      undefined,
      "0123456789abcdef",
    ]);
  });

  it("re-arms the streak when the record carrying its revision is not delivered", () => {
    const undelivered: Array<(() => void) | undefined> = [];
    const reporter: CallReporter = {
      report: (_record, onUndelivered) => undelivered.push(onUndelivered),
      drain: async () => {},
    };
    const { rearmed, source } = binding("0123456789abcdef");
    const journal = connectionCallJournal(reporter, {
      integrationId: "@test/integ",
      connectionId: "conn-a",
      source,
    });
    const credential = { revision: "0123456789abcdef" };
    journal({
      method: "GET",
      host: "h",
      outcome: "200",
      durationMs: 1,
      startedAtMs: Date.now(),
      credential: null,
    });
    journal({
      method: "GET",
      host: "h",
      outcome: "200",
      durationMs: 1,
      startedAtMs: Date.now(),
      credential,
    });
    expect(undelivered[0]).toBeUndefined();
    undelivered[1]!();
    expect(rearmed).toEqual(["0123456789abcdef"]);
  });
});

describe("POST /calls/flush", () => {
  it("answers once the queued journal has landed on the platform", async () => {
    let release!: () => void;
    const landed = new Promise<void>((resolve) => (release = resolve));
    const { posts, fetchFn } = platform(async () => {
      await landed;
      return new Response(null, { status: 204 });
    });
    const reporter = createCallReporter({
      platformApiUrl: "http://platform",
      runToken: "run-tok",
      fetchFn,
      flushIntervalMs: 60_000,
    });
    const app = createTestApp({
      config: { platformApiUrl: "http://platform", runToken: "run-tok", proxyUrl: "" },
      cookieJar: new Map(),
      flushCallJournal: () => reporter.drain(),
    });
    reporter.report(record());

    let answered = false;
    const response = Promise.resolve(app.request("/calls/flush", { method: "POST" })).then(
      (res) => {
        answered = true;
        return res;
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(posts.map((p) => p.calls)).toEqual([[record()]]);
    expect(answered).toBe(false);

    release();
    expect((await response).status).toBe(204);
  });

  it("answers 204 on a sidecar with no journal", async () => {
    const app = createTestApp({
      config: { platformApiUrl: "http://platform", runToken: "run-tok", proxyUrl: "" },
      cookieJar: new Map(),
    });
    expect((await app.request("/calls/flush", { method: "POST" })).status).toBe(204);
  });
});
