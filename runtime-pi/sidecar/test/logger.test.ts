// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { logger, _setLogSinkForTesting } from "../logger.ts";

const prevLevel = process.env.LOG_LEVEL;

afterEach(() => {
  _setLogSinkForTesting(null);
  if (prevLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = prevLevel;
});

function capture(fn: () => void): Array<Record<string, unknown>> {
  const lines: string[] = [];
  _setLogSinkForTesting((_level, line) => lines.push(line));
  fn();
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("sidecar logger", () => {
  it("writes pino-compatible lines: numeric level, epoch-ms time, msg", () => {
    process.env.LOG_LEVEL = "debug";
    const before = Date.now();
    const records = capture(() => {
      logger.debug("d");
      logger.info("i", { k: 1 });
      logger.warn("w");
      logger.error("e");
    });
    expect(records.map((r) => r.level)).toEqual([20, 30, 40, 50]);
    expect(records.map((r) => r.msg)).toEqual(["d", "i", "w", "e"]);
    expect(records[1]!.k).toBe(1);
    for (const r of records) {
      expect(typeof r.time).toBe("number");
      expect(r.time as number).toBeGreaterThanOrEqual(before);
    }
  });

  it("drops lines below the LOG_LEVEL threshold", () => {
    process.env.LOG_LEVEL = "warn";
    const records = capture(() => {
      logger.info("dropped");
      logger.warn("kept");
    });
    expect(records.map((r) => r.msg)).toEqual(["kept"]);
  });
});
