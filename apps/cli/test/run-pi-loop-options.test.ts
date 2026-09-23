// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { piLoopOptionsFromShell } from "../src/commands/run.ts";

describe("piLoopOptionsFromShell", () => {
  it("keeps both loops on and the runner's cap when nothing is set", () => {
    expect(piLoopOptionsFromShell({})).toEqual({ modelRetry: true, modelCompaction: true });
  });

  it('turns a loop off only on exactly "false"', () => {
    expect(
      piLoopOptionsFromShell({ MODEL_RETRY_ENABLED: "false", MODEL_COMPACTION_ENABLED: "0" }),
    ).toEqual({ modelRetry: false, modelCompaction: true });
  });

  it("passes a valid byte cap and ignores an invalid one", () => {
    expect(piLoopOptionsFromShell({ TOOL_RESULT_BYTE_LIMIT: "8192" }).toolResultByteLimit).toBe(
      8192,
    );
    for (const bad of ["abc", "-1", "0", "12.5", ""]) {
      expect(piLoopOptionsFromShell({ TOOL_RESULT_BYTE_LIMIT: bad }).toolResultByteLimit).toBe(
        undefined,
      );
    }
  });
});
