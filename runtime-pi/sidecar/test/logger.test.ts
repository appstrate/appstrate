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
  it("drops lines below LOG_LEVEL and writes pino's numeric level with the fields", () => {
    process.env.LOG_LEVEL = "warn";
    const records = capture(() => {
      logger.info("dropped");
      logger.warn("kept", { k: 1 });
    });
    expect(records).toEqual([expect.objectContaining({ level: 40, msg: "kept", k: 1 })]);
  });
});
