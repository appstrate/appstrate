// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * The `output` tool is always injected, but whether the agent MUST call it
 * is conditional on the run declaring an output schema (via OUTPUT_SCHEMA):
 *   - schema present  → calling output (once, valid) is required.
 *   - schema absent   → output is optional; a side-effect-only run that
 *                       finishes without emitting output is a valid success.
 * This contract lives in the tool description shown to the LLM.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { outputTool } from "../src/runtime-tools/builtin/output.ts";

function captureDescription(): string {
  let description = "";
  // Minimal ExtensionAPI stub — the factory only calls registerTool.
  const pi = {
    registerTool: (cfg: { description: string }) => {
      description = cfg.description;
    },
  } as unknown as Parameters<typeof outputTool>[0];
  outputTool(pi);
  return description;
}

describe("output tool description", () => {
  const original = process.env.OUTPUT_SCHEMA;
  afterEach(() => {
    if (original === undefined) delete process.env.OUTPUT_SCHEMA;
    else process.env.OUTPUT_SCHEMA = original;
  });

  it("is optional (not mandatory) when no output schema is declared", () => {
    delete process.env.OUTPUT_SCHEMA;
    const description = captureDescription();
    expect(description).toContain("Optional");
    expect(description).toContain("finish without calling it");
    expect(description).not.toContain("MANDATORY");
  });

  it("requires a single valid call when an output schema is declared", () => {
    process.env.OUTPUT_SCHEMA = JSON.stringify({
      type: "object",
      required: ["result"],
      properties: { result: { type: "string" } },
    });
    const description = captureDescription();
    expect(description).toContain("Call exactly once");
    expect(description).toContain("schema");
    expect(description).not.toContain("Optional");
  });
});
