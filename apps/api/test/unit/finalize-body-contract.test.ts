// SPDX-License-Identifier: Apache-2.0

/**
 * The finalize body declares its outcome contract instead of the platform
 * inferring it: `status` is required, and `usage` is required on a success
 * (it is what tells a real success from a run that never reached the LLM).
 */

import { describe, it, expect } from "bun:test";
import { RunResultSchema } from "../../src/routes/runs-events.ts";

const USAGE = { input_tokens: 12, output_tokens: 4 };

function issuePaths(body: unknown): string[] {
  const parsed = RunResultSchema.safeParse(body);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join("."));
}

describe("finalize body contract", () => {
  it("rejects a body without status — no inference from `error`", () => {
    expect(issuePaths({ usage: USAGE })).toEqual(["status"]);
    expect(issuePaths({ error: { message: "boom" } })).toEqual(["status"]);
  });

  it("rejects a status outside the terminal run statuses", () => {
    expect(issuePaths({ status: "running", usage: USAGE })).toEqual(["status"]);
  });

  it("requires usage when status is success", () => {
    expect(issuePaths({ status: "success" })).toEqual(["usage"]);
    expect(issuePaths({ status: "success", usage: USAGE })).toEqual([]);
  });

  it("rejects a malformed usage instead of dropping it", () => {
    expect(issuePaths({ status: "success", usage: { input_tokens: -1 } })).toEqual([
      "usage.input_tokens",
    ]);
  });

  it("accepts a non-success status without usage", () => {
    for (const status of ["failed", "timeout", "cancelled"]) {
      expect(issuePaths({ status, error: { message: "x" } })).toEqual([]);
    }
  });
});
