// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { createRuntimeEventDrainer, type DrainLogger } from "../src/runtime-event-drain.ts";
import type { RuntimeToolEvent } from "../src/runtime-tool-defs.ts";

/** A scriptable fetch: each entry is the JSON body returned for the next call. */
function scriptedFetch(
  batches: Array<{ events: RuntimeToolEvent[]; cursor: number; firstSeq?: number } | "error">,
) {
  const urls: string[] = [];
  let i = 0;
  const fn = (async (url: string | URL) => {
    urls.push(String(url));
    const batch = batches[Math.min(i, batches.length - 1)];
    i += 1;
    if (batch === "error") throw new Error("network down");
    return new Response(JSON.stringify(batch), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, urls };
}

function captureLogger() {
  const lines: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  const logger: DrainLogger = {
    warn: (msg, data) => lines.push({ level: "warn", msg, data }),
    error: (msg, data) => lines.push({ level: "error", msg, data }),
  };
  return { logger, lines };
}

const ev = (message: string): RuntimeToolEvent =>
  ({ type: "log.written", level: "info", message }) as unknown as RuntimeToolEvent;

describe("createRuntimeEventDrainer — cursor advance", () => {
  it("pulls events after the cursor and advances it on each drain", async () => {
    const { fn, urls } = scriptedFetch([
      { events: [ev("a"), ev("b")], cursor: 2 },
      { events: [ev("c")], cursor: 3 },
    ]);
    const d = createRuntimeEventDrainer({ url: "http://sidecar:8088/runtime-events", fetch: fn });

    expect((await d.drain()).map((e) => (e as Record<string, unknown>).message)).toEqual([
      "a",
      "b",
    ]);
    expect((await d.drain()).map((e) => (e as Record<string, unknown>).message)).toEqual(["c"]);

    expect(urls[0]).toContain("after=0");
    expect(urls[1]).toContain("after=2");
  });

  it("sends the configured Host header", async () => {
    let seenHeaders: RequestInit["headers"];
    const fn = (async (_url: string, init?: RequestInit) => {
      seenHeaders = init?.headers;
      return new Response(JSON.stringify({ events: [], cursor: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    const d = createRuntimeEventDrainer({
      url: "http://sidecar:8088/runtime-events",
      headers: { Host: "sidecar" },
      fetch: fn,
    });
    await d.drain();
    expect((seenHeaders as Record<string, string>).Host).toBe("sidecar");
  });
});

describe("createRuntimeEventDrainer — intermediate mode", () => {
  it("returns [] and logs on a fetch error without throwing; cursor unchanged", async () => {
    const { fn } = scriptedFetch(["error", { events: [ev("a")], cursor: 1 }]);
    const { logger, lines } = captureLogger();
    const d = createRuntimeEventDrainer({
      url: "http://sidecar:8088/runtime-events",
      fetch: fn,
      logger,
    });

    expect(await d.drain()).toEqual([]);
    expect(lines.some((l) => l.msg === "runtime_events_drain_fetch_failed")).toBe(true);
    // Next drain still starts from cursor 0 (the failed pull did not advance it).
    expect((await d.drain()).map((e) => (e as Record<string, unknown>).message)).toEqual(["a"]);
  });
});

describe("createRuntimeEventDrainer — final mode", () => {
  it("loops until the journal is empty, accumulating every batch", async () => {
    const { fn } = scriptedFetch([
      { events: [ev("a")], cursor: 1 },
      { events: [ev("b"), ev("c")], cursor: 3 },
      { events: [], cursor: 3 },
    ]);
    const d = createRuntimeEventDrainer({ url: "http://sidecar:8088/runtime-events", fetch: fn });
    const out = await d.drain({ final: true });
    expect(out.map((e) => (e as Record<string, unknown>).message)).toEqual(["a", "b", "c"]);
  });

  it("retries transient failures then gives up loud (runtime_events_incomplete), never throws", async () => {
    const { fn } = scriptedFetch(["error", "error", "error"]);
    const { logger, lines } = captureLogger();
    const d = createRuntimeEventDrainer({
      url: "http://sidecar:8088/runtime-events",
      fetch: fn,
      logger,
    });
    const out = await d.drain({ final: true });
    expect(out).toEqual([]);
    expect(lines.some((l) => l.msg === "runtime_events_incomplete")).toBe(true);
  });
});

describe("createRuntimeEventDrainer — truncation signal", () => {
  it("logs runtime_events_truncated when the journal evicted past the cursor", async () => {
    const { fn } = scriptedFetch([{ events: [ev("late")], cursor: 12, firstSeq: 5 }]);
    const { logger, lines } = captureLogger();
    const d = createRuntimeEventDrainer({
      url: "http://sidecar:8088/runtime-events",
      fetch: fn,
      logger,
    });
    await d.drain();
    expect(lines.some((l) => l.level === "error" && l.msg === "runtime_events_truncated")).toBe(
      true,
    );
  });
});
