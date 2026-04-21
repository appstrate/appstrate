// SPDX-License-Identifier: Apache-2.0

/**
 * Post-Phase-7: parsePiStreamLine is a thin RunEvent shape validator.
 * The container (`runtime-pi/entrypoint.ts` → PiRunner) now emits
 * canonical AFPS RunEvents directly. The translation layer moved
 * upstream into `@appstrate/runner-pi` and is covered by that
 * package's own tests.
 */

import { describe, it, expect } from "bun:test";
import { parsePiStreamLine } from "../../src/services/adapters/pi.ts";

const RUN_ID = "run_test";

describe("parsePiStreamLine (post-PiRunner)", () => {
  it("passes through a well-formed RunEvent verbatim", () => {
    const event = {
      type: "memory.added",
      timestamp: 1_700_000_000,
      runId: RUN_ID,
      content: "learned X",
    };
    const parsed = parsePiStreamLine(JSON.stringify(event), RUN_ID)!;
    expect(parsed.type).toBe("memory.added");
    expect(parsed.content).toBe("learned X");
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.timestamp).toBe(1_700_000_000);
  });

  it("passes through an appstrate.metric event unchanged", () => {
    const event = {
      type: "appstrate.metric",
      timestamp: 1_700_000_000,
      runId: RUN_ID,
      usage: { input_tokens: 100, output_tokens: 50 },
      cost: 0.004,
    };
    const parsed = parsePiStreamLine(JSON.stringify(event), RUN_ID)!;
    expect(parsed.type).toBe("appstrate.metric");
    expect(parsed.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(parsed.cost).toBe(0.004);
  });

  it("wraps non-RunEvent JSON as a [container] progress breadcrumb", () => {
    const line = JSON.stringify({ random: "object", not: "a run event" });
    const parsed = parsePiStreamLine(line, RUN_ID)!;
    expect(parsed.type).toBe("appstrate.progress");
    expect(String(parsed.message ?? "")).toContain("[container]");
  });

  it("wraps unparseable lines as a [container] progress breadcrumb", () => {
    const parsed = parsePiStreamLine("this is not JSON", RUN_ID)!;
    expect(parsed.type).toBe("appstrate.progress");
    expect(String(parsed.message ?? "")).toContain("this is not JSON");
  });

  it("returns null on empty / whitespace-only lines", () => {
    expect(parsePiStreamLine("", RUN_ID)).toBeNull();
    expect(parsePiStreamLine("   \n", RUN_ID)).toBeNull();
  });

  it("rejects events missing required envelope fields", () => {
    const missingRunId = JSON.stringify({ type: "output.emitted", timestamp: 1 });
    const parsed = parsePiStreamLine(missingRunId, RUN_ID)!;
    // Missing runId → not a valid RunEvent → wrapped as breadcrumb.
    expect(parsed.type).toBe("appstrate.progress");
    expect(String(parsed.message ?? "")).toContain("[container]");
  });
});
