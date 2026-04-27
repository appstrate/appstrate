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
  isTruncationMarker,
  resolveVerbosity,
  unwrapMcpContent,
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

  it("renders the bridge's truncation marker as a human-readable size in normal mode", () => {
    const marker = { __truncated: true, reason: "size", bytes: 99999, limit: 2048 };
    const out = formatToolResult(marker, "normal");
    expect(out).toContain("truncated");
    expect(out).toContain("KB");
    expect(out).not.toContain("__truncated");
  });
});

describe("unwrapMcpContent", () => {
  it("returns null for non-MCP shapes", () => {
    expect(unwrapMcpContent(null)).toBe(null);
    expect(unwrapMcpContent(undefined)).toBe(null);
    expect(unwrapMcpContent("string")).toBe(null);
    expect(unwrapMcpContent(42)).toBe(null);
    expect(unwrapMcpContent({})).toBe(null);
    expect(unwrapMcpContent({ content: "not an array" })).toBe(null);
    expect(unwrapMcpContent({ content: [] })).toBe(null);
    expect(unwrapMcpContent({ content: [{ type: "image" }] })).toBe(null);
  });

  it("extracts a single text block", () => {
    expect(unwrapMcpContent({ content: [{ type: "text", text: "hello" }] })).toBe("hello");
  });

  it("joins multiple text blocks with newlines", () => {
    const out = unwrapMcpContent({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });
    expect(out).toBe("first\nsecond");
  });

  it("skips non-text blocks (image, resource)", () => {
    const out = unwrapMcpContent({
      content: [
        { type: "text", text: "real" },
        { type: "image", data: "..." },
        { type: "resource", uri: "..." },
        { type: "text", text: "more" },
      ],
    });
    expect(out).toBe("real\nmore");
  });

  it("returns null when text array contains no text blocks", () => {
    expect(unwrapMcpContent({ content: [{ type: "image" }, { type: "resource" }] })).toBe(null);
  });

  it("ignores blocks with non-string text fields", () => {
    expect(unwrapMcpContent({ content: [{ type: "text", text: 42 }] })).toBe(null);
  });
});

describe("isTruncationMarker", () => {
  it("recognises the bridge's truncation marker", () => {
    expect(isTruncationMarker({ __truncated: true, bytes: 9999, limit: 2048 })).toBe(true);
    expect(
      isTruncationMarker({
        __truncated: true,
        bytes: 9999,
        limit: 2048,
        reason: "size",
        preview: "...",
      }),
    ).toBe(true);
  });

  it("rejects non-marker values", () => {
    expect(isTruncationMarker(null)).toBe(false);
    expect(isTruncationMarker(undefined)).toBe(false);
    expect(isTruncationMarker("string")).toBe(false);
    expect(isTruncationMarker({ __truncated: true })).toBe(false); // missing bytes/limit
    expect(isTruncationMarker({ __truncated: false, bytes: 1, limit: 1 })).toBe(false);
    expect(isTruncationMarker({ bytes: 1, limit: 1 })).toBe(false);
  });
});

describe("formatToolResult — MCP unwrapping", () => {
  it("renders just the text from an MCP envelope (single block)", () => {
    const out = formatToolResult(
      { content: [{ type: "text", text: "Logged [info]: hello world" }] },
      "normal",
    );
    expect(out).toBe("Logged [info]: hello world");
    expect(out).not.toContain('"content"');
    expect(out).not.toContain('"type"');
  });

  it("joins multi-block MCP envelopes with collapsed newlines in normal mode", () => {
    const out = formatToolResult(
      {
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      },
      "normal",
    );
    expect(out).not.toContain("\n");
    expect(out).toContain("↵");
    expect(out).toContain("line one");
    expect(out).toContain("line two");
  });

  it("preserves real newlines in verbose mode", () => {
    const out = formatToolResult(
      {
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      },
      "verbose",
    );
    expect(out).toBe("line one\nline two");
  });

  it("falls back to JSON for non-MCP objects", () => {
    const out = formatToolResult({ ok: true, n: 1 }, "normal");
    expect(out).toBe('{"ok":true,"n":1}');
  });
});

describe("formatToolResult — truncation marker", () => {
  it("renders bytes/limit in human units", () => {
    const out = formatToolResult(
      { __truncated: true, bytes: 12244, limit: 2048, reason: "size" },
      "normal",
    );
    expect(out).toContain("truncated");
    // 12244 B = 11.96 KB → rendered as "12 KB" (≥10 → integer)
    expect(out).toContain("12 KB");
    // 2048 B = 2.0 KB → rendered as "2.0 KB" (<10 → 1 decimal)
    expect(out).toContain("2.0 KB");
    expect(out).not.toContain("__truncated");
    expect(out).not.toContain('"reason"');
  });

  it("unwraps MCP envelope inside JSON-encoded preview", () => {
    const innerEnvelope = JSON.stringify({
      content: [{ type: "text", text: "Logged [info]: J'ai récupéré..." }],
    });
    const out = formatToolResult(
      { __truncated: true, bytes: 6895, limit: 2048, preview: innerEnvelope },
      "normal",
    );
    expect(out).toContain("truncated");
    expect(out).toContain("6.7 KB");
    expect(out).toContain("Logged [info]: J'ai récupéré...");
    expect(out).not.toContain('"content"');
    expect(out).not.toContain('\\"');
  });

  it("falls back to raw preview when it isn't JSON", () => {
    const out = formatToolResult(
      { __truncated: true, bytes: 5000, limit: 2048, preview: "just a plain string" },
      "normal",
    );
    expect(out).toContain("just a plain string");
  });

  it("omits preview blurb when preview is empty", () => {
    const out = formatToolResult({ __truncated: true, bytes: 9999, limit: 2048 }, "normal");
    expect(out).toBe("(truncated 9.8 KB > 2.0 KB)");
  });

  it("formats sub-KB sizes in bytes", () => {
    const out = formatToolResult({ __truncated: true, bytes: 600, limit: 100 }, "normal");
    expect(out).toContain("600 B");
    expect(out).toContain("100 B");
  });

  it("formats MB-sized payloads", () => {
    const out = formatToolResult({ __truncated: true, bytes: 5_500_000, limit: 2048 }, "normal");
    expect(out).toContain("5.2 MB");
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
