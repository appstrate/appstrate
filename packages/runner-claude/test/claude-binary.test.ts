// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, expect, it } from "bun:test";
import {
  candidateBinaryPackages,
  binaryFileName,
  resolveClaudeCodeBinary,
  buildClaudeSdkEnv,
} from "../src/claude-binary.ts";

describe("candidateBinaryPackages", () => {
  it("linux tries the musl variant first, then glibc", () => {
    expect(candidateBinaryPackages("linux", "x64")).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
      "@anthropic-ai/claude-agent-sdk-linux-x64",
    ]);
    expect(candidateBinaryPackages("linux", "arm64")).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
      "@anthropic-ai/claude-agent-sdk-linux-arm64",
    ]);
  });

  it("darwin / win32 have a single per-arch candidate", () => {
    expect(candidateBinaryPackages("darwin", "arm64")).toEqual([
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    ]);
    expect(candidateBinaryPackages("win32", "x64")).toEqual([
      "@anthropic-ai/claude-agent-sdk-win32-x64",
    ]);
  });

  it("unknown platform yields no candidates", () => {
    expect(candidateBinaryPackages("freebsd" as NodeJS.Platform, "x64")).toEqual([]);
  });
});

describe("binaryFileName", () => {
  it("claude.exe on Windows, claude elsewhere", () => {
    expect(binaryFileName("win32")).toBe("claude.exe");
    expect(binaryFileName("linux")).toBe("claude");
    expect(binaryFileName("darwin")).toBe("claude");
  });
});

describe("resolveClaudeCodeBinary", () => {
  it("returns the first candidate that resolves", () => {
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

  it("falls through to the glibc variant when musl is absent", () => {
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

  it("throws a descriptive error listing the tried specifiers when none resolve", () => {
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

  it("error mentions the platform when no candidate exists at all", () => {
    expect(() =>
      resolveClaudeCodeBinary({
        platform: "freebsd" as NodeJS.Platform,
        arch: "x64",
        resolve: () => "unused",
      }),
    ).toThrow(/freebsd\/x64/);
  });
});

describe("buildClaudeSdkEnv", () => {
  it("curates env: gateway pointers, blanked API key, telemetry off, no process.env leak", () => {
    const env = buildClaudeSdkEnv({ baseUrl: "http://gw", placeholderToken: "ph" });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://gw");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ph");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.DISABLE_TELEMETRY).toBe("1");
    expect(env.DISABLE_ERROR_REPORTING).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    // A platform secret in process.env must not leak into the subprocess env.
    expect(Object.keys(env)).not.toContain("DATABASE_URL");
  });

  it("merges explicit extra env (non-protected keys)", () => {
    const env = buildClaudeSdkEnv({
      baseUrl: "http://gw",
      placeholderToken: "ph",
      extra: { FOO: "bar" },
    });
    expect(env.FOO).toBe("bar");
  });

  it("extra can never override the credential-isolation keys", () => {
    const env = buildClaudeSdkEnv({
      baseUrl: "http://gw",
      placeholderToken: "ph",
      extra: {
        ANTHROPIC_BASE_URL: "http://attacker.example",
        ANTHROPIC_AUTH_TOKEN: "sk-stolen",
        ANTHROPIC_API_KEY: "sk-stolen",
        FOO: "bar",
      },
    });
    // The builder re-asserts the protected keys last so a caller-supplied
    // `extra` can neither redirect the binary's upstream nor swap its credential.
    expect(env.ANTHROPIC_BASE_URL).toBe("http://gw");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ph");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    // Non-protected extra keys still pass through.
    expect(env.FOO).toBe("bar");
  });
});
