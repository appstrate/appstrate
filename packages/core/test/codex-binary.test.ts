// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, expect, test } from "bun:test";
import {
  buildCodexAuthJson,
  buildCodexEnv,
  codexBinaryPackage,
  codexTargetTriple,
  resolveCodexBinary,
} from "../src/codex-binary.ts";

describe("codexTargetTriple", () => {
  test("linux is musl (runs on Alpine)", () => {
    expect(codexTargetTriple("linux", "x64")).toBe("x86_64-unknown-linux-musl");
    expect(codexTargetTriple("linux", "arm64")).toBe("aarch64-unknown-linux-musl");
  });
  test("darwin + win32", () => {
    expect(codexTargetTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(codexTargetTriple("win32", "x64")).toBe("x86_64-pc-windows-msvc");
  });
  test("unknown arch → null", () => {
    expect(codexTargetTriple("linux", "ia32")).toBeNull();
    expect(codexTargetTriple("freebsd" as NodeJS.Platform, "x64")).toBeNull();
  });
});

describe("codexBinaryPackage", () => {
  test("per-platform package name", () => {
    expect(codexBinaryPackage("linux", "arm64")).toBe("@openai/codex-linux-arm64");
    expect(codexBinaryPackage("darwin", "x64")).toBe("@openai/codex-darwin-x64");
  });
});

describe("resolveCodexBinary", () => {
  test("resolves the vendored musl binary path on linux", () => {
    const resolved = resolveCodexBinary({
      platform: "linux",
      arch: "arm64",
      resolve: (s) => `/store/${s}`,
    });
    expect(resolved).toBe(
      "/store/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex",
    );
  });
  test("throws a descriptive error when the package is absent", () => {
    expect(() =>
      resolveCodexBinary({
        platform: "linux",
        arch: "x64",
        resolve: () => {
          throw new Error("not found");
        },
      }),
    ).toThrow(/Could not resolve the Codex native binary/);
  });
});

describe("buildCodexAuthJson", () => {
  test("access_token is the caller's gateway-auth token, sent verbatim", () => {
    const now = 1_700_000_000_000;
    const auth = buildCodexAuthJson({ accessToken: "chatloop_abc.def", nowMs: now });
    expect(auth.auth_mode).toBe("chatgpt");
    // Bearer = the loopback/gateway token verbatim (not a JWT).
    expect(auth.tokens.access_token).toBe("chatloop_abc.def");
    expect(auth.tokens.refresh_token).toBe("placeholder-refresh");
    expect(auth.last_refresh).toBe(new Date(now).toISOString());
  });
  test("id_token is a valid-format JWT with far-future exp (so the CLI boots)", () => {
    const now = 1_700_000_000_000;
    const auth = buildCodexAuthJson({ accessToken: "x", nowMs: now });
    const parts = auth.tokens.id_token.split(".");
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    expect(payload.exp).toBeGreaterThan(Math.floor(now / 1000));
  });
});

describe("buildCodexEnv", () => {
  test("sets CODEX_HOME and cannot be overridden by extra", () => {
    const env = buildCodexEnv({ codexHome: "/run/codex", extra: { CODEX_HOME: "/evil" } });
    expect(env.CODEX_HOME).toBe("/run/codex");
    expect(env.CODEX_DISABLE_UPDATE_CHECK).toBe("1");
  });
});
