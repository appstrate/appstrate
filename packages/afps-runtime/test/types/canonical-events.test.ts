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
      { ...baseEnvelope, type: "pinned.set", key: "checkpoint", content: { counter: 1 } },
      { ...baseEnvelope, type: "pinned.set", key: "checkpoint", content: { c: 2 }, scope: "actor" },
      { ...baseEnvelope, type: "pinned.set", key: "persona", content: "agent A" },
      { ...baseEnvelope, type: "output.emitted", data: { ok: true } },
      { ...baseEnvelope, type: "log.written", level: "info", message: "x" },
      { ...baseEnvelope, type: "report.appended", content: "# Report\n\nMarkdown body" },
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
    // appstrate.progress without message
    expect(isCanonicalRunEvent({ ...baseEnvelope, type: "appstrate.progress" } as RunEvent)).toBe(
      false,
    );
    // report.appended without content
    expect(isCanonicalRunEvent({ ...baseEnvelope, type: "report.appended" } as RunEvent)).toBe(
      false,
    );
    // report.appended with non-string content
    expect(
      isCanonicalRunEvent({ ...baseEnvelope, type: "report.appended", content: 42 } as RunEvent),
    ).toBe(false);
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

  it("accepts run lifecycle events (#278 item I)", () => {
    expect(isCanonicalRunEvent({ ...baseEnvelope, type: "run.started" })).toBe(true);
    expect(
      isCanonicalRunEvent({
        ...baseEnvelope,
        type: "run.started",
        runnerKind: "platform",
        runnerName: "appstrate-pi@1.0.0",
      }),
    ).toBe(true);
    expect(isCanonicalRunEvent({ ...baseEnvelope, type: "run.success", durationMs: 4200 })).toBe(
      true,
    );
    expect(isCanonicalRunEvent({ ...baseEnvelope, type: "run.timeout" })).toBe(true);
    expect(
      isCanonicalRunEvent({ ...baseEnvelope, type: "run.cancelled", reason: "user_cancelled" }),
    ).toBe(true);
  });

  it("accepts run.failed with structured error", () => {
    expect(
      isCanonicalRunEvent({
        ...baseEnvelope,
        type: "run.failed",
        error: { code: "manifest_invalid", message: "missing scope" },
      }),
    ).toBe(true);
    // Error is optional.
    expect(isCanonicalRunEvent({ ...baseEnvelope, type: "run.failed" })).toBe(true);
  });

  it("rejects run.failed with malformed error (no message)", () => {
    expect(
      isCanonicalRunEvent({
        ...baseEnvelope,
        type: "run.failed",
        error: { code: "x" },
      } as RunEvent),
    ).toBe(false);
    expect(
      isCanonicalRunEvent({ ...baseEnvelope, type: "run.failed", error: 42 } as RunEvent),
    ).toBe(false);
  });

  it("rejects run.failed with malformed structured error fields", () => {
    // code must be string when present
    expect(
      isCanonicalRunEvent({
        ...baseEnvelope,
        type: "run.failed",
        error: { message: "boom", code: 42 },
      } as RunEvent),
    ).toBe(false);
    // stack must be string when present
    expect(
      isCanonicalRunEvent({
        ...baseEnvelope,
        type: "run.failed",
        error: { message: "boom", stack: 123 },
      } as RunEvent),
    ).toBe(false);
    // timestamp must be string (RFC 3339) when present
    expect(
      isCanonicalRunEvent({
        ...baseEnvelope,
        type: "run.failed",
        error: { message: "boom", timestamp: 1700000000 },
      } as RunEvent),
    ).toBe(false);
    // context must be plain object when present
    expect(
      isCanonicalRunEvent({
        ...baseEnvelope,
        type: "run.failed",
        error: { message: "boom", context: "oops" },
      } as RunEvent),
    ).toBe(false);
    expect(
      isCanonicalRunEvent({
        ...baseEnvelope,
        type: "run.failed",
        error: { message: "boom", context: ["arr"] },
      } as RunEvent),
    ).toBe(false);
  });

  it("accepts run.failed with all structured fields well-formed", () => {
    expect(
      isCanonicalRunEvent({
        ...baseEnvelope,
        type: "run.failed",
        error: {
          code: "manifest_invalid",
          message: "missing scope",
          stack: "Error: …",
          timestamp: "2026-04-25T10:00:00.000Z",
          context: { providerId: "@appstrate/gmail", retries: 2 },
        },
      }),
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
    // 8 reserved namespaces (memory/pinned/output/log/report + appstrate.{progress,error,metric})
    // + 5 run lifecycle events (run.{started,success,failed,timeout,cancelled}, #278 item I).
    expect(arr.length).toBe(13);
    expect(new Set(arr).size).toBe(arr.length);
  });
});

describe("assertExhaustive", () => {
  it("throws when called (used as a compile-time guard)", () => {
    // Cast through unknown to simulate the runtime "shouldn't happen" path.
    expect(() => assertExhaustive("forbidden" as unknown as never)).toThrow(/Unhandled canonical/);
  });
});
