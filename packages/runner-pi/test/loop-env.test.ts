// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { parsePiLoopEnv } from "../src/loop-env.ts";

describe("parsePiLoopEnv", () => {
  it("defaults both loops on and leaves the cap to the runner", () => {
    expect(parsePiLoopEnv({})).toEqual({
      options: { modelRetry: true, modelCompaction: true },
      issues: [],
    });
    expect(parsePiLoopEnv({ TOOL_RESULT_BYTE_LIMIT: "" }).options.toolResultByteLimit).toBe(
      undefined,
    );
  });

  it("reads the exact booleans and a positive integer cap", () => {
    expect(
      parsePiLoopEnv({
        MODEL_RETRY_ENABLED: "false",
        MODEL_COMPACTION_ENABLED: "false",
        TOOL_RESULT_BYTE_LIMIT: "16384",
      }),
    ).toEqual({
      options: { modelRetry: false, modelCompaction: false, toolResultByteLimit: 16384 },
      issues: [],
    });
  });

  it("reports every malformed value", () => {
    const { issues } = parsePiLoopEnv({
      MODEL_RETRY_ENABLED: "0",
      MODEL_COMPACTION_ENABLED: "yes",
      TOOL_RESULT_BYTE_LIMIT: "12.5",
    });
    expect(issues).toEqual([
      'MODEL_RETRY_ENABLED: must be "true" or "false" (got "0")',
      'MODEL_COMPACTION_ENABLED: must be "true" or "false" (got "yes")',
      'TOOL_RESULT_BYTE_LIMIT: must be a positive integer (got "12.5")',
    ]);
  });
});
