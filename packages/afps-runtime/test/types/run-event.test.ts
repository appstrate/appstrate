// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  toRunEvent,
  fromRunEvent,
  LEGACY_RUN_EVENT_TYPES,
  type RunEvent,
} from "../../src/types/run-event.ts";

describe("toRunEvent", () => {
  const runId = "run_123";
  const nowMs = 1_745_000_000_000;

  it("maps add_memory → memory.added with content", () => {
    const evt = toRunEvent({
      event: { type: "add_memory", content: "hello" },
      runId,
      nowMs,
    });
    expect(evt.type).toBe("memory.added");
    expect(evt.runId).toBe(runId);
    expect(evt.timestamp).toBe(nowMs);
    expect(evt.content).toBe("hello");
  });

  it("maps set_state → state.set with state payload", () => {
    const evt = toRunEvent({
      event: { type: "set_state", state: { step: 2 } },
      runId,
      nowMs,
    });
    expect(evt.type).toBe("state.set");
    expect(evt.state).toEqual({ step: 2 });
  });

  it("maps output → output.emitted with data", () => {
    const evt = toRunEvent({
      event: { type: "output", data: { ok: true } },
      runId,
      nowMs,
    });
    expect(evt.type).toBe("output.emitted");
    expect(evt.data).toEqual({ ok: true });
  });

  it("maps report → report.appended with content", () => {
    const evt = toRunEvent({
      event: { type: "report", content: "line" },
      runId,
      nowMs,
    });
    expect(evt.type).toBe("report.appended");
    expect(evt.content).toBe("line");
  });

  it("maps log → log.written with level + message", () => {
    const evt = toRunEvent({
      event: { type: "log", level: "warn", message: "watch out" },
      runId,
      nowMs,
    });
    expect(evt.type).toBe("log.written");
    expect(evt.level).toBe("warn");
    expect(evt.message).toBe("watch out");
  });

  it("propagates toolCallId when provided", () => {
    const evt = toRunEvent({
      event: { type: "add_memory", content: "x" },
      runId,
      toolCallId: "call_abc",
      nowMs,
    });
    expect(evt.toolCallId).toBe("call_abc");
  });

  it("omits toolCallId when absent (no explicit undefined in envelope)", () => {
    const evt = toRunEvent({
      event: { type: "add_memory", content: "x" },
      runId,
      nowMs,
    });
    expect("toolCallId" in evt).toBe(false);
  });

  it("defaults timestamp to Date.now() when nowMs absent", () => {
    const before = Date.now();
    const evt = toRunEvent({ event: { type: "report", content: "x" }, runId });
    const after = Date.now();
    expect(evt.timestamp).toBeGreaterThanOrEqual(before);
    expect(evt.timestamp).toBeLessThanOrEqual(after);
  });

  it("exposes a complete legacy → core-domain mapping table", () => {
    expect(LEGACY_RUN_EVENT_TYPES).toEqual({
      add_memory: "memory.added",
      set_state: "state.set",
      output: "output.emitted",
      report: "report.appended",
      log: "log.written",
    });
  });
});

describe("fromRunEvent", () => {
  const base = { timestamp: 1, runId: "r" } as const;

  it("round-trips memory.added", () => {
    const evt: RunEvent = { ...base, type: "memory.added", content: "m" };
    expect(fromRunEvent(evt)).toEqual({ type: "add_memory", content: "m" });
  });

  it("round-trips state.set with arbitrary state payload", () => {
    const state = { nested: { n: 1 } };
    const evt: RunEvent = { ...base, type: "state.set", state };
    expect(fromRunEvent(evt)).toEqual({ type: "set_state", state });
  });

  it("round-trips output.emitted", () => {
    const evt: RunEvent = { ...base, type: "output.emitted", data: [1, 2] };
    expect(fromRunEvent(evt)).toEqual({ type: "output", data: [1, 2] });
  });

  it("round-trips report.appended", () => {
    const evt: RunEvent = { ...base, type: "report.appended", content: "x" };
    expect(fromRunEvent(evt)).toEqual({ type: "report", content: "x" });
  });

  it("round-trips log.written", () => {
    const evt: RunEvent = {
      ...base,
      type: "log.written",
      level: "error",
      message: "m",
    };
    expect(fromRunEvent(evt)).toEqual({ type: "log", level: "error", message: "m" });
  });

  it("returns null for unknown / third-party event types", () => {
    expect(fromRunEvent({ ...base, type: "@my/audit.logged", what: "x" })).toBeNull();
  });

  it("returns null for malformed core-domain events (wrong field type)", () => {
    expect(fromRunEvent({ ...base, type: "memory.added", content: 42 })).toBeNull();
    expect(fromRunEvent({ ...base, type: "log.written", level: "debug", message: "x" })).toBeNull();
    expect(fromRunEvent({ ...base, type: "log.written", level: "info", message: 42 })).toBeNull();
  });
});
