// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { piLoopOptionsFromShell } from "../src/commands/run.ts";

describe("piLoopOptionsFromShell", () => {
  it("keeps both loops on and the runner's cap when nothing is set", () => {
    expect(piLoopOptionsFromShell({})).toEqual({ modelRetry: true, modelCompaction: true });
  });

  it('turns a loop off on "false" and passes a valid byte cap', () => {
    expect(
      piLoopOptionsFromShell({
        MODEL_RETRY_ENABLED: "false",
        MODEL_COMPACTION_ENABLED: "true",
        TOOL_RESULT_BYTE_LIMIT: "8192",
      }),
    ).toEqual({ modelRetry: false, modelCompaction: true, toolResultByteLimit: 8192 });
  });

  it("refuses a malformed value, as the container does", () => {
    expect(() => piLoopOptionsFromShell({ MODEL_COMPACTION_ENABLED: "0" })).toThrow(
      /MODEL_COMPACTION_ENABLED: must be "true" or "false"/,
    );
    for (const bad of ["abc", "-1", "0", "12.5"]) {
      expect(() => piLoopOptionsFromShell({ TOOL_RESULT_BYTE_LIMIT: bad })).toThrow(
        /TOOL_RESULT_BYTE_LIMIT: must be a positive integer/,
      );
    }
  });
});
