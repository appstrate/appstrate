// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the run-command format helpers — pure functions, no
 * stdout / streams / files. Verifies the parity contract with the web
 * log viewer (`apps/web/src/components/log-utils.ts → formatToolArgs`):
 * same compact rendering shape, same 200-char ceiling, same null/undef
 * skipping. Adding a new verbosity tier lands here first.
 */

import { describe, it, expect } from "bun:test";
import {
  ARGS_PREVIEW_CHARS,
  RESULT_PREVIEW_CHARS,
  RESULT_VERBOSE_CHARS,
  formatToolArgsCompact,
  formatToolArgsVerbose,
  formatToolResult,
  resolveVerbosity,
} from "../src/commands/run/format.ts";

describe("formatToolArgsCompact", () => {
  it("returns empty string for null/undefined/non-object", () => {
    expect(formatToolArgsCompact(null)).toBe("");
    expect(formatToolArgsCompact(undefined)).toBe("");
  });

  it("renders key: value pairs joined with comma+space", () => {
    expect(formatToolArgsCompact({ path: "/tmp/x", limit: 10 })).toBe("path: /tmp/x, limit: 10");
  });

  it("skips null and undefined values", () => {
    expect(formatToolArgsCompact({ a: 1, b: null, c: undefined, d: "x" })).toBe("a: 1, d: x");
  });

  it("JSON-stringifies non-string values", () => {
    expect(formatToolArgsCompact({ flag: true, list: [1, 2] })).toBe("flag: true, list: [1,2]");
  });

  it("truncates output at ARGS_PREVIEW_CHARS with trailing ellipsis", () => {
    const long = "x".repeat(500);
    const out = formatToolArgsCompact({ data: long });
    expect(out.length).toBe(ARGS_PREVIEW_CHARS + 3); // "..."
    expect(out.endsWith("...")).toBe(true);
  });

  it("returns empty when every value is null or undefined", () => {
    expect(formatToolArgsCompact({ a: null, b: undefined })).toBe("");
  });

  it("returns empty for an empty object", () => {
    expect(formatToolArgsCompact({})).toBe("");
  });
});

describe("formatToolArgsVerbose", () => {
  it("returns empty string for null/undefined", () => {
    expect(formatToolArgsVerbose(null)).toBe("");
    expect(formatToolArgsVerbose(undefined)).toBe("");
  });

  it("returns String() for primitives", () => {
    expect(formatToolArgsVerbose(42)).toBe("42");
    expect(formatToolArgsVerbose("hello")).toBe("hello");
  });

  it("pretty-prints objects with 2-space indent", () => {
    const out = formatToolArgsVerbose({ a: 1, b: { c: 2 } });
    expect(out).toContain("\n");
    expect(out).toContain('  "a": 1');
    expect(out).toContain('  "b": {');
    expect(out).toContain('    "c": 2');
  });

  it("falls back to compact on circular references", () => {
    const c: Record<string, unknown> = { name: "x" };
    c.self = c;
    // The compact form skips object values that aren't pre-stringifiable
    // — but `name: x` should still come through.
    const out = formatToolArgsVerbose(c);
    expect(out).toContain("name: x");
  });
});

describe("formatToolResult", () => {
  it("returns empty for null/undefined regardless of mode", () => {
    expect(formatToolResult(null, "normal")).toBe("");
    expect(formatToolResult(undefined, "normal")).toBe("");
    expect(formatToolResult(null, "verbose")).toBe("");
  });

  it("renders strings as-is in verbose mode (preserves newlines)", () => {
    const out = formatToolResult("line1\nline2", "verbose");
    expect(out).toBe("line1\nline2");
  });

  it("replaces newlines with ↵ in normal mode", () => {
    const out = formatToolResult("line1\nline2", "normal");
    expect(out).not.toContain("\n");
    expect(out).toContain("↵");
  });

  it("truncates at RESULT_PREVIEW_CHARS in normal mode", () => {
    const long = "x".repeat(500);
    const out = formatToolResult(long, "normal");
    expect(out.length).toBe(RESULT_PREVIEW_CHARS + 3);
    expect(out.endsWith("...")).toBe(true);
  });

  it("truncates at RESULT_VERBOSE_CHARS in verbose mode", () => {
    const long = "x".repeat(5000);
    const out = formatToolResult(long, "verbose");
    expect(out.length).toBe(RESULT_VERBOSE_CHARS + 3);
    expect(out.endsWith("...")).toBe(true);
  });

  it("JSON-stringifies objects in normal mode (single line)", () => {
    const out = formatToolResult({ ok: true, n: 1 }, "normal");
    expect(out).toBe('{"ok":true,"n":1}');
  });

  it("pretty-prints objects in verbose mode (multi-line)", () => {
    const out = formatToolResult({ ok: true }, "verbose");
    expect(out).toContain("\n");
    expect(out).toContain('"ok": true');
  });

  it("renders the bridge's truncation marker as JSON in normal mode", () => {
    const marker = { __truncated: true, reason: "size", bytes: 99999, limit: 2048 };
    const out = formatToolResult(marker, "normal");
    expect(out).toContain("__truncated");
    expect(out).toContain("size");
  });
});

describe("resolveVerbosity", () => {
  it("defaults to 'normal' when nothing is set", () => {
    expect(resolveVerbosity({})).toBe("normal");
    expect(resolveVerbosity({ envValue: "" })).toBe("normal");
    expect(resolveVerbosity({ envValue: undefined })).toBe("normal");
  });

  it("returns 'verbose' when --verbose is set", () => {
    expect(resolveVerbosity({ verbose: true })).toBe("verbose");
  });

  it("returns 'quiet' when --quiet is set", () => {
    expect(resolveVerbosity({ quiet: true })).toBe("quiet");
  });

  it("explicit flags win over env var", () => {
    expect(resolveVerbosity({ verbose: true, envValue: "quiet" })).toBe("verbose");
    expect(resolveVerbosity({ quiet: true, envValue: "1" })).toBe("quiet");
  });

  it("APPSTRATE_VERBOSE=1 / true → verbose", () => {
    expect(resolveVerbosity({ envValue: "1" })).toBe("verbose");
    expect(resolveVerbosity({ envValue: "true" })).toBe("verbose");
  });

  it("APPSTRATE_VERBOSE=quiet → quiet", () => {
    expect(resolveVerbosity({ envValue: "quiet" })).toBe("quiet");
  });

  it("unknown env values fall back to normal", () => {
    expect(resolveVerbosity({ envValue: "yes" })).toBe("normal");
    expect(resolveVerbosity({ envValue: "0" })).toBe("normal");
  });
});
