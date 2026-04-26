// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { createLogger } from "../src/logger.ts";

describe("createLogger", () => {
  it("returns an object with debug, info, warn, error methods", () => {
    const logger = createLogger("info");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("accepts valid pino log levels", () => {
    expect(() => createLogger("debug")).not.toThrow();
    expect(() => createLogger("info")).not.toThrow();
    expect(() => createLogger("warn")).not.toThrow();
    expect(() => createLogger("error")).not.toThrow();
  });

  it("log methods accept msg and optional data", () => {
    const logger = createLogger("debug");
    expect(() => logger.info("test message")).not.toThrow();
    expect(() => logger.info("test message", { key: "value" })).not.toThrow();
  });
});
