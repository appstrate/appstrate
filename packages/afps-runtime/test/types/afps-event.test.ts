// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { afpsEventSchema } from "../../src/types/afps-event.ts";

describe("afpsEventSchema", () => {
  it("accepts add_memory", () => {
    const result = afpsEventSchema.safeParse({
      type: "add_memory",
      content: "user prefers metric units",
    });
    expect(result.success).toBe(true);
  });

  it("accepts set_state with arbitrary state payload", () => {
    const result = afpsEventSchema.safeParse({
      type: "set_state",
      state: { counter: 42, cursor: "abc" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts output with arbitrary data payload", () => {
    const result = afpsEventSchema.safeParse({
      type: "output",
      data: { items: [1, 2, 3] },
    });
    expect(result.success).toBe(true);
  });

  it("accepts report", () => {
    const result = afpsEventSchema.safeParse({
      type: "report",
      content: "## Summary\n\nAll good.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts log with each valid level", () => {
    for (const level of ["info", "warn", "error"] as const) {
      const result = afpsEventSchema.safeParse({
        type: "log",
        level,
        message: "hello",
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects unknown event type", () => {
    const result = afpsEventSchema.safeParse({
      type: "mystery",
      foo: "bar",
    });
    expect(result.success).toBe(false);
  });

  it("rejects add_memory with empty content", () => {
    const result = afpsEventSchema.safeParse({
      type: "add_memory",
      content: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects log with invalid level", () => {
    const result = afpsEventSchema.safeParse({
      type: "log",
      level: "debug", // not in the v1 canonical set
      message: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects payload missing required discriminator", () => {
    const result = afpsEventSchema.safeParse({
      content: "no type field",
    });
    expect(result.success).toBe(false);
  });

  it("narrows discriminated union at the type level", () => {
    const parsed = afpsEventSchema.parse({
      type: "add_memory",
      content: "pinned",
    });
    // Exhaustive narrowing — will error at compile time if a new variant
    // is added without updating the branch below.
    switch (parsed.type) {
      case "add_memory":
        expect(parsed.content).toBe("pinned");
        break;
      case "set_state":
      case "output":
      case "report":
      case "log":
        throw new Error("unreachable for this input");
    }
  });
});
