// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { reduceEvents, emptyRunResult } from "../../src/runner/reducer.ts";
import type { AfpsEvent } from "../../src/types/afps-event.ts";

describe("reduceEvents", () => {
  it("returns an empty baseline for an empty stream", () => {
    const r = reduceEvents([]);
    expect(r).toEqual(emptyRunResult());
  });

  it("appends memories in event order", () => {
    const events: AfpsEvent[] = [
      { type: "add_memory", content: "a" },
      { type: "add_memory", content: "b" },
    ];
    const r = reduceEvents(events);
    expect(r.memories.map((m) => m.content)).toEqual(["a", "b"]);
  });

  it("applies set_state with last-write-wins", () => {
    const events: AfpsEvent[] = [
      { type: "set_state", state: { v: 1 } },
      { type: "set_state", state: { v: 2 } },
    ];
    expect(reduceEvents(events).state).toEqual({ v: 2 });
  });

  it("merges object output values", () => {
    const events: AfpsEvent[] = [
      { type: "output", data: { a: 1, b: 1 } },
      { type: "output", data: { b: 2, c: 3 } },
    ];
    expect(reduceEvents(events).output).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("replaces output wholesale on non-object values", () => {
    const events: AfpsEvent[] = [
      { type: "output", data: { a: 1 } },
      { type: "output", data: "scalar" },
    ];
    expect(reduceEvents(events).output).toBe("scalar");
  });

  it("replaces output wholesale on array values (no array merge)", () => {
    const events: AfpsEvent[] = [
      { type: "output", data: { a: 1 } },
      { type: "output", data: [1, 2, 3] },
    ];
    expect(reduceEvents(events).output).toEqual([1, 2, 3]);
  });

  it("concatenates report content with \\n separators", () => {
    const events: AfpsEvent[] = [
      { type: "report", content: "one" },
      { type: "report", content: "two" },
      { type: "report", content: "three" },
    ];
    expect(reduceEvents(events).report).toBe("one\ntwo\nthree");
  });

  it("appends log entries with the injected timestamp", () => {
    let t = 1000;
    const events: AfpsEvent[] = [
      { type: "log", level: "info", message: "a" },
      { type: "log", level: "warn", message: "b" },
    ];
    const r = reduceEvents(events, { nowMs: () => t++ });
    expect(r.logs).toEqual([
      { level: "info", message: "a", timestamp: 1000 },
      { level: "warn", message: "b", timestamp: 1001 },
    ]);
  });

  it("attaches an error when provided via opts", () => {
    const r = reduceEvents([], { error: { message: "boom" } });
    expect(r.error).toEqual({ message: "boom" });
  });

  it("does not mutate the input events", () => {
    const events: AfpsEvent[] = [{ type: "add_memory", content: "x" }];
    reduceEvents(events);
    expect(events).toEqual([{ type: "add_memory", content: "x" }]);
  });
});
