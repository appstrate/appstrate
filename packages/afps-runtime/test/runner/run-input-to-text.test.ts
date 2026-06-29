// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { runInputToText } from "../../src/runner/run-input-to-text.ts";

describe("runInputToText", () => {
  it("trims a string input", () => {
    expect(runInputToText("hello")).toBe("hello");
    expect(runInputToText("  padded  ")).toBe("padded");
  });

  it("returns the empty string for null / undefined", () => {
    expect(runInputToText(null)).toBe("");
    expect(runInputToText(undefined)).toBe("");
  });

  it("returns the empty string for a whitespace-only string", () => {
    expect(runInputToText("   ")).toBe("");
  });

  it("JSON-stringifies an object input", () => {
    expect(runInputToText({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
    expect(runInputToText([1, 2, 3])).toBe("[1,2,3]");
    expect(runInputToText(42)).toBe("42");
  });

  it("returns the empty string when the value is not serialisable (catch path)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(runInputToText(circular)).toBe("");

    // BigInt throws inside JSON.stringify → caught → "".
    expect(runInputToText(10n)).toBe("");
  });
});
