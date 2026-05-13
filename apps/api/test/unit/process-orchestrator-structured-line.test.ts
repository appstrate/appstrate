// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `tryParseStructured` — the helper that detects when a
 * subprocess output line is a pino-style structured JSON log so the
 * orchestrator's `drainStdout` / `drainStderr` can forward it through
 * the API logger preserving its level + structured fields, rather than
 * double-encoding it as `{level:"info", msg:"[process:X:stdout] {\"level\":...}"}`.
 *
 * Sidecar / agent stdout & stderr both flow through this — see
 * `services/orchestrator/process-orchestrator.ts` for the call sites.
 */

import { describe, it, expect } from "bun:test";
import { tryParseStructured } from "../../src/services/orchestrator/process-orchestrator.ts";

describe("tryParseStructured", () => {
  it("returns the parsed object for a well-formed pino line", () => {
    const line = JSON.stringify({
      level: "info",
      time: "2026-05-13T15:00:00.000Z",
      msg: "llm.stream.observed",
      bytes: 113380,
      maxIdleMs: 9_512,
    });
    const parsed = tryParseStructured(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.level).toBe("info");
    expect(parsed?.msg).toBe("llm.stream.observed");
    expect(parsed?.bytes).toBe(113380);
    expect(parsed?.maxIdleMs).toBe(9_512);
  });

  it("accepts each of debug/info/warn/error as a valid level", () => {
    for (const level of ["debug", "info", "warn", "error"] as const) {
      const parsed = tryParseStructured(JSON.stringify({ level, msg: "ok" }));
      expect(parsed?.level).toBe(level);
    }
  });

  it("returns null for plain text (non-JSON)", () => {
    expect(tryParseStructured("hello world")).toBeNull();
    expect(tryParseStructured("[INFO] something happened")).toBeNull();
  });

  it("returns null for a JSON array", () => {
    expect(tryParseStructured(JSON.stringify(["info", "msg"]))).toBeNull();
  });

  it("returns null when `level` is missing or not a recognised value", () => {
    expect(tryParseStructured(JSON.stringify({ msg: "hi" }))).toBeNull();
    expect(tryParseStructured(JSON.stringify({ level: "trace", msg: "hi" }))).toBeNull();
    expect(tryParseStructured(JSON.stringify({ level: 30, msg: "hi" }))).toBeNull();
  });

  it("returns null when `msg` is missing or not a string", () => {
    expect(tryParseStructured(JSON.stringify({ level: "info" }))).toBeNull();
    expect(tryParseStructured(JSON.stringify({ level: "info", msg: 123 }))).toBeNull();
  });

  it("returns null for `null` or primitives wrapped as JSON", () => {
    expect(tryParseStructured("null")).toBeNull();
    expect(tryParseStructured('"a string"')).toBeNull();
    expect(tryParseStructured("42")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(tryParseStructured("{level:'info',msg:'x'}")).toBeNull();
    expect(tryParseStructured("")).toBeNull();
    expect(tryParseStructured("{")).toBeNull();
  });
});
