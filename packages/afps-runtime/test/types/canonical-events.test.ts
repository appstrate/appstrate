// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { RunEvent } from "@afps-spec/types";
import {
  CANONICAL_EVENT_TYPES,
  assertExhaustive,
  isCanonicalRunEvent,
  narrowCanonicalEvent,
  type CanonicalRunEvent,
} from "../../src/types/canonical-events.ts";

const baseEnvelope = { timestamp: 1, runId: "r1" };

describe("isCanonicalRunEvent", () => {
  it("accepts all canonical, well-formed events", () => {
    const events: RunEvent[] = [
      { ...baseEnvelope, type: "memory.added", content: "hello" },
      { ...baseEnvelope, type: "memory.added", content: "scoped", scope: "shared" },
      { ...baseEnvelope, type: "checkpoint.set", data: { counter: 1 } },
      { ...baseEnvelope, type: "checkpoint.set", data: { c: 2 }, scope: "actor" },
      { ...baseEnvelope, type: "output.emitted", data: { ok: true } },
      { ...baseEnvelope, type: "report.appended", content: "## Title" },
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

  it("rejects malformed scope on memory.added or checkpoint.set", () => {
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
        type: "checkpoint.set",
        data: 1,
        scope: "everyone",
      } as RunEvent),
    ).toBe(false);
    // checkpoint.set without `data` is rejected
    expect(isCanonicalRunEvent({ ...baseEnvelope, type: "checkpoint.set" } as RunEvent)).toBe(
      false,
    );
  });

  it("rejects third-party event types", () => {
    expect(isCanonicalRunEvent({ ...baseEnvelope, type: "@my-org/audit.logged", payload: 1 })).toBe(
      false,
    );
    expect(isCanonicalRunEvent({ ...baseEnvelope, type: "provider.called", method: "GET" })).toBe(
      false,
    );
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
    // report.appended without content
    expect(isCanonicalRunEvent({ ...baseEnvelope, type: "report.appended" } as RunEvent)).toBe(
      false,
    );
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

describe("narrowCanonicalEvent", () => {
  it("returns the same event when canonical", () => {
    const event: RunEvent = { ...baseEnvelope, type: "output.emitted", data: 42 };
    const narrow = narrowCanonicalEvent(event);
    // Identity comparison — narrow is a sub-type of RunEvent so cast for the matcher.
    expect(narrow as unknown).toBe(event as unknown);
  });

  it("returns null when not canonical", () => {
    const event: RunEvent = { ...baseEnvelope, type: "@third-party/x", v: 1 };
    expect(narrowCanonicalEvent(event)).toBeNull();
  });

  it("uses the discriminant for type narrowing in switch statements", () => {
    const event: RunEvent = { ...baseEnvelope, type: "log.written", level: "warn", message: "x" };
    const narrow = narrowCanonicalEvent(event);
    if (narrow !== null && narrow.type === "log.written") {
      // TypeScript narrowing — these accesses are typed.
      expect(narrow.level).toBe("warn");
      expect(narrow.message).toBe("x");
    } else {
      throw new Error("expected canonical narrowing");
    }
  });
});

describe("CANONICAL_EVENT_TYPES", () => {
  it("matches the union exhaustively (compile + runtime)", () => {
    // Compile-time: each entry must be a CanonicalRunEvent['type']
    const arr: ReadonlyArray<CanonicalRunEvent["type"]> = CANONICAL_EVENT_TYPES;
    expect(arr.length).toBe(8);
    expect(new Set(arr).size).toBe(arr.length);
  });
});

describe("assertExhaustive", () => {
  it("throws when called (used as a compile-time guard)", () => {
    // Cast through unknown to simulate the runtime "shouldn't happen" path.
    expect(() => assertExhaustive("forbidden" as unknown as never)).toThrow(/Unhandled canonical/);
  });
});
