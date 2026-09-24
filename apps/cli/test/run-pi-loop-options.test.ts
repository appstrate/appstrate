// SPDX-License-Identifier: Apache-2.0

// The knob grammar is tested in packages/runner-pi/test/loop-env.test.ts.
import { describe, it, expect } from "bun:test";
import { piLoopOptionsFromShell } from "../src/commands/run.ts";

describe("piLoopOptionsFromShell", () => {
  it("returns the parsed options", () => {
    expect(
      piLoopOptionsFromShell({ MODEL_RETRY_ENABLED: "false", TOOL_RESULT_BYTE_LIMIT: "8192" }),
    ).toEqual({ modelRetry: false, modelCompaction: true, toolResultByteLimit: 8192 });
  });

  it("throws on a malformed value, as the container does", () => {
    expect(() => piLoopOptionsFromShell({ TOOL_RESULT_BYTE_LIMIT: "12.5" })).toThrow(
      /TOOL_RESULT_BYTE_LIMIT/,
    );
  });
});
