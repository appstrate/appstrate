// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { summarizeRunOutput } from "../run-output-summary.ts";

describe("summarizeRunOutput", () => {
  it("reads the first text of the output on one line", () => {
    expect(summarizeRunOutput({ output: { count: 3, resume: "- Un\n- Deux" } })).toEqual({
      kind: "text",
      text: "Un - Deux",
    });
  });

  it("drops the Markdown a model writes", () => {
    expect(summarizeRunOutput({ output: { text: "1. **Santé** : dormir" } })).toEqual({
      kind: "text",
      text: "Santé : dormir",
    });
  });

  it("counts the fields when none is a text", () => {
    expect(summarizeRunOutput({ output: { a: 1, b: { c: 2 } } })).toEqual({
      kind: "fields",
      count: 2,
    });
  });

  it("says nothing for a run with no output", () => {
    expect(summarizeRunOutput(null)).toBeNull();
    expect(summarizeRunOutput({})).toBeNull();
    expect(summarizeRunOutput({ output: {} })).toBeNull();
  });

  it("caps a long text", () => {
    const summary = summarizeRunOutput({ output: { text: "a".repeat(1000) } });
    expect(summary?.kind === "text" && summary.text.length).toBe(300);
  });
});
