// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { formatLogLine } from "../src/log-line.ts";

describe("formatLogLine", () => {
  it("emits one pino-compatible line: numeric level, epoch-ms time, msg, fields", () => {
    const before = Date.now();
    const raw = formatLogLine("warn", "mcp_connect_retry", { attempt: 2 });
    expect(raw.endsWith("\n")).toBe(true);
    const record = JSON.parse(raw) as Record<string, unknown>;
    expect(record.level).toBe(40);
    expect(record.msg).toBe("mcp_connect_retry");
    expect(record.attempt).toBe(2);
    expect(record.time as number).toBeGreaterThanOrEqual(before);
  });

  it("uses pino's scale for every level", () => {
    const levels = (["debug", "info", "warn", "error"] as const).map(
      (l) => JSON.parse(formatLogLine(l, "x")).level,
    );
    expect(levels).toEqual([20, 30, 40, 50]);
  });
});
