// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import {
  candidateBinaryPackages,
  binaryFileName,
  resolveClaudeCodeBinary,
} from "../src/claude-agent/binary.ts";

describe("candidateBinaryPackages", () => {
  test("linux tries the musl variant first, then glibc", () => {
    expect(candidateBinaryPackages("linux", "x64")).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
      "@anthropic-ai/claude-agent-sdk-linux-x64",
    ]);
    expect(candidateBinaryPackages("linux", "arm64")).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
      "@anthropic-ai/claude-agent-sdk-linux-arm64",
    ]);
  });

  test("darwin / win32 have a single per-arch candidate", () => {
    expect(candidateBinaryPackages("darwin", "arm64")).toEqual([
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    ]);
    expect(candidateBinaryPackages("win32", "x64")).toEqual([
      "@anthropic-ai/claude-agent-sdk-win32-x64",
    ]);
  });

  test("unknown platform yields no candidates", () => {
    expect(candidateBinaryPackages("freebsd" as NodeJS.Platform, "x64")).toEqual([]);
  });
});

describe("binaryFileName", () => {
  test("claude.exe on Windows, claude elsewhere", () => {
    expect(binaryFileName("win32")).toBe("claude.exe");
    expect(binaryFileName("linux")).toBe("claude");
    expect(binaryFileName("darwin")).toBe("claude");
  });
});

describe("resolveClaudeCodeBinary", () => {
  test("returns the first candidate that resolves", () => {
    const resolved = resolveClaudeCodeBinary({
      platform: "linux",
      arch: "x64",
      resolve: (s) => {
        if (s === "@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude") return "/opt/musl/claude";
        throw new Error("not found");
      },
    });
    expect(resolved).toBe("/opt/musl/claude");
  });

  test("falls through to the glibc variant when musl is absent", () => {
    const resolved = resolveClaudeCodeBinary({
      platform: "linux",
      arch: "x64",
      resolve: (s) => {
        if (s === "@anthropic-ai/claude-agent-sdk-linux-x64/claude") return "/usr/lib/claude";
        throw new Error("not found");
      },
    });
    expect(resolved).toBe("/usr/lib/claude");
  });

  test("throws a descriptive error listing the tried specifiers when none resolve", () => {
    expect(() =>
      resolveClaudeCodeBinary({
        platform: "linux",
        arch: "arm64",
        resolve: () => {
          throw new Error("not found");
        },
      }),
    ).toThrow(/claude-agent-sdk-linux-arm64-musl\/claude.*claude-agent-sdk-linux-arm64\/claude/s);
  });

  test("error mentions the platform when no candidate exists at all", () => {
    expect(() =>
      resolveClaudeCodeBinary({
        platform: "freebsd" as NodeJS.Platform,
        arch: "x64",
        resolve: () => "unused",
      }),
    ).toThrow(/freebsd\/x64/);
  });

  // Integration: the real per-arch binary the installed SDK ships for THIS
  // host must resolve to an existing executable. Guards the
  // optional-dependency wiring (and the main-SDK-scope anchoring) end-to-end —
  // a missing binary here would otherwise surface as an opaque SDK spawn crash
  // at the first chat turn.
  test("resolves the installed native binary on this host", () => {
    const path = resolveClaudeCodeBinary();
    expect(path).toContain("claude-agent-sdk-");
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(1_000_000);
  });
});
