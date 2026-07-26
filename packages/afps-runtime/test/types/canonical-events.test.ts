// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { RunEvent } from "@afps-spec/types";
import {
  CANONICAL_EVENT_TYPES,
  isCanonicalRunEvent,
  type CanonicalRunEvent,
} from "../../src/types/canonical-events.ts";

const baseEnvelope = { timestamp: 1, runId: "r1" };

describe("isCanonicalRunEvent", () => {
  it("accepts all canonical, well-formed events", () => {
    const events: RunEvent[] = [
      { ...baseEnvelope, type: "memory.added", content: "hello" },
      { ...baseEnvelope, type: "memory.added", content: "scoped", scope: "shared" },
      { ...baseEnvelope, type: "pinned.set", key: "checkpoint", content: { counter: 1 } },
      { ...baseEnvelope, type: "pinned.set", key: "checkpoint", content: { c: 2 }, scope: "actor" },
      { ...baseEnvelope, type: "pinned.set", key: "persona", content: "agent A" },
      { ...baseEnvelope, type: "output.emitted", data: { ok: true } },
      { ...baseEnvelope, type: "log.written", level: "info", message: "x" },
      { ...baseEnvelope, type: "appstrate.progress", message: "running" },
      { ...baseEnvelope, type: "appstrate.error", message: "boom" },
      {
        ...baseEnvelope,
        type: "appstrate.metric",
        usage: { input_tokens: 10, output_tokens: 5 },
        cost: 0.01,
      },
    ];
    for (const e of events) expect(isCanonicalRunEvent(e)).toBe(true);
  });

  it("rejects malformed scope on memory.added or pinned.set", () => {
    expect(
      isCanonicalRunEvent({
        ...baseEnvelope,
        type: "memory.added",
        content: "x",
        scope: "global",
      } as RunEvent),
    ).toBe(false);
    expect(
      isCanonicalRunEvent({
        ...baseEnvelope,
        type: "pinned.set",
        key: "checkpoint",
        content: 1,
        scope: "everyone",
      } as RunEvent),
    ).toBe(false);
    // pinned.set without `key` is rejected
    expect(
      isCanonicalRunEvent({
        ...baseEnvelope,
        type: "pinned.set",
        content: 1,
      } as RunEvent),
    ).toBe(false);
    // pinned.set without `content` is rejected
    expect(
      isCanonicalRunEvent({
        ...baseEnvelope,
        type: "pinned.set",
        key: "checkpoint",
      } as RunEvent),
    ).toBe(false);
  });

  it("rejects third-party event types", () => {
    expect(isCanonicalRunEvent({ ...baseEnvelope, type: "@my-org/audit.logged", payload: 1 })).toBe(
      false,
    );
    expect(isCanonicalRunEvent({ ...baseEnvelope, type: "api_call.called", method: "GET" })).toBe(
      false,
    );
    // `report.appended` was canonical until the report tool was retired in
    // favour of durable `outputs/` documents — a stale emitter is now
    // third-party as far as the runtime is concerned.
    expect(
      isCanonicalRunEvent({ ...baseEnvelope, type: "report.appended", content: "# Report" }),
    ).toBe(false);
  });

  it("rejects malformed canonical events (tampered payloads)", () => {
    // memory.added without content
    expect(isCanonicalRunEvent({ ...baseEnvelope, type: "memory.added" } as RunEvent)).toBe(false);
    // memory.added with non-string content
    expect(
      isCanonicalRunEvent({ ...baseEnvelope, type: "memory.added", content: 42 } as RunEvent),
    ).toBe(false);
    // log.written with bad level
    expect(
      isCanonicalRunEvent({
        ...baseEnvelope,
        type: "log.written",
        level: "debug",
        message: "x",
      } as RunEvent),
    ).toBe(false);
    // log.written without message
    expect(
      isCanonicalRunEvent({
        ...baseEnvelope,
        type: "log.written",
        level: "info",
      } as RunEvent),
    ).toBe(false);
    // appstrate.progress without message
    expect(isCanonicalRunEvent({ ...baseEnvelope, type: "appstrate.progress" } as RunEvent)).toBe(
      false,
    );
    // appstrate.metric with non-object usage
    expect(
      isCanonicalRunEvent({ ...baseEnvelope, type: "appstrate.metric", usage: 42 } as RunEvent),
    ).toBe(false);
    // appstrate.metric with negative cost
    expect(
      isCanonicalRunEvent({ ...baseEnvelope, type: "appstrate.metric", cost: -1 } as RunEvent),
    ).toBe(false);
    // appstrate.metric with non-finite cost
    expect(
      isCanonicalRunEvent({
        ...baseEnvelope,
        type: "appstrate.metric",
        cost: Number.POSITIVE_INFINITY,
      } as RunEvent),
    ).toBe(false);
  });

  it("accepts appstrate.metric with no payload (durationMs-only or empty)", () => {
    // A runner with no LLM traffic still emits a metric event — usage
    // and cost are both optional.
    expect(isCanonicalRunEvent({ ...baseEnvelope, type: "appstrate.metric" } as RunEvent)).toBe(
      true,
    );
    expect(
      isCanonicalRunEvent({
        ...baseEnvelope,
        type: "appstrate.metric",
        durationMs: 1234,
      } as RunEvent),
    ).toBe(true);
  });
});

describe("isCanonicalRunEvent — type-guard narrowing", () => {
  // The guard's declared predicate (`event is CanonicalRunEvent`) is what lets
  // `foldEvent`'s switch be exhaustively typed. Assert it here so a widening of
  // the return type is caught by this file and not only by the reducer.
  it("uses the discriminant for type narrowing in switch statements", () => {
    const event: RunEvent = { ...baseEnvelope, type: "log.written", level: "warn", message: "x" };
    if (isCanonicalRunEvent(event) && event.type === "log.written") {
      // TypeScript narrowing — these accesses are typed.
      expect(event.level).toBe("warn");
      expect(event.message).toBe("x");
    } else {
      throw new Error("expected canonical narrowing");
    }
  });
});

describe("CANONICAL_EVENT_TYPES", () => {
  it("matches the union exhaustively (compile + runtime)", () => {
    // Compile-time: each entry must be a CanonicalRunEvent['type']
    const arr: ReadonlyArray<CanonicalRunEvent["type"]> = CANONICAL_EVENT_TYPES;
    // 4 reserved AFPS namespaces (memory/pinned/output/log)
    // + 3 appstrate.* platform-internal events (progress/error/metric).
    expect(arr.length).toBe(7);
    expect(new Set(arr).size).toBe(arr.length);
  });
});
