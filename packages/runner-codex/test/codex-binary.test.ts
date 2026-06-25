// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, expect, it } from "bun:test";
import { readFile, stat, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexAuthJson,
  buildCodexConfigToml,
  buildCodexEnv,
  codexBinaryPackage,
  codexTargetTriple,
  readNdjsonLines,
  redactSecrets,
  resolveCodexBinary,
  safeParseJson,
  writeCodexAuthHome,
  writeCodexConfig,
} from "../src/codex-binary.ts";

async function dirExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("codexTargetTriple", () => {
  it("linux is musl (runs on Alpine)", () => {
    expect(codexTargetTriple("linux", "x64")).toBe("x86_64-unknown-linux-musl");
    expect(codexTargetTriple("linux", "arm64")).toBe("aarch64-unknown-linux-musl");
  });
  it("darwin + win32", () => {
    expect(codexTargetTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(codexTargetTriple("win32", "x64")).toBe("x86_64-pc-windows-msvc");
  });
  it("unknown arch → null", () => {
    expect(codexTargetTriple("linux", "ia32")).toBeNull();
    expect(codexTargetTriple("freebsd" as NodeJS.Platform, "x64")).toBeNull();
  });
});

describe("codexBinaryPackage", () => {
  it("per-platform package name", () => {
    expect(codexBinaryPackage("linux", "arm64")).toBe("@openai/codex-linux-arm64");
    expect(codexBinaryPackage("darwin", "x64")).toBe("@openai/codex-darwin-x64");
  });
});

describe("resolveCodexBinary", () => {
  it("resolves the vendored musl binary path on linux", () => {
    const resolved = resolveCodexBinary({
      platform: "linux",
      arch: "arm64",
      resolve: (s) => `/store/${s}`,
    });
    expect(resolved).toBe(
      "/store/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex",
    );
  });
  it("throws a descriptive error when the package is absent", () => {
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
  it("access_token is the caller's gateway-auth token, sent verbatim", () => {
    const now = 1_700_000_000_000;
    const auth = buildCodexAuthJson({ accessToken: "chatloop_abc.def", nowMs: now });
    expect(auth.auth_mode).toBe("chatgpt");
    // The real vended subscription token, written verbatim (the CLI sends it to
    // chatgpt.com directly).
    expect(auth.tokens.access_token).toBe("chatloop_abc.def");
    expect(auth.last_refresh).toBe(new Date(now).toISOString());
  });
  it("id_token is a valid-format JWT with far-future exp (so the CLI boots)", () => {
    const now = 1_700_000_000_000;
    const auth = buildCodexAuthJson({ accessToken: "x", nowMs: now });
    const parts = auth.tokens.id_token.split(".");
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    expect(payload.exp).toBeGreaterThan(Math.floor(now / 1000));
  });
});

describe("writeCodexAuthHome", () => {
  it("materialises auth.json (0600) holding buildCodexAuthJson output, and returns the home", async () => {
    const now = 1_700_000_000_000;
    const home = await writeCodexAuthHome({
      credential: { access_token: "tok_real", account_id: "acct_123" },
      nowMs: now,
      prefix: "codex-test-",
    });
    try {
      const path = join(home, "auth.json");
      // Real token on disk → MUST be owner-only (0600).
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
      const written = JSON.parse(await readFile(path, "utf8"));
      expect(written).toEqual(
        buildCodexAuthJson({ accessToken: "tok_real", accountId: "acct_123", nowMs: now }),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("tolerates a credential with no account_id (falls back to the placeholder)", async () => {
    const home = await writeCodexAuthHome({
      credential: { access_token: "tok" },
      nowMs: 1_700_000_000_000,
    });
    try {
      const written = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
      expect(written.tokens.account_id).toBe("00000000-0000-0000-0000-000000000000");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("buildCodexEnv", () => {
  it("sets CODEX_HOME and cannot be overridden by extra", () => {
    const env = buildCodexEnv({ codexHome: "/run/codex", extra: { CODEX_HOME: "/evil" } });
    expect(env.CODEX_HOME).toBe("/run/codex");
    expect(env.CODEX_DISABLE_UPDATE_CHECK).toBe("1");
  });
});

describe("redactSecrets", () => {
  it("strips Bearer tokens, JWTs, and sk- keys from subprocess stderr", () => {
    const dirty =
      "auth failed for Bearer sk-proj-AAAABBBBCCCCDDDD1234 using eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.";
    const clean = redactSecrets(dirty);
    expect(clean).not.toContain("sk-proj-AAAABBBBCCCCDDDD1234");
    expect(clean).not.toContain("eyJhbGciOiJub25lIn0");
    expect(clean).toContain("Bearer [REDACTED]");
    expect(clean).toContain("[REDACTED_JWT]");
  });
  it("leaves non-secret diagnostics intact", () => {
    const msg = "ENOENT: codex binary not found at /usr/local/bin/codex (exit 127)";
    expect(redactSecrets(msg)).toBe(msg);
  });

  it("redacts MULTIPLE distinct Bearer tokens in one line (all replaced)", () => {
    const dirty = "tried Bearer abc123DEF456ghi789 then retried with Bearer zzz999YYY888www777";
    const clean = redactSecrets(dirty);
    expect(clean).not.toContain("abc123DEF456ghi789");
    expect(clean).not.toContain("zzz999YYY888www777");
    // Both occurrences collapse to the redacted form.
    expect(clean.match(/Bearer \[REDACTED\]/g)).toHaveLength(2);
  });

  it("redacts a known secret VALUE even when it has no Bearer/JWT/sk- shape", () => {
    const token = "abcdef0123456789xyz"; // non-JWT, non-sk-, no Bearer prefix
    const clean = redactSecrets(`leaked raw token ${token} in output`, [token]);
    expect(clean).not.toContain(token);
    expect(clean).toContain("[REDACTED]");
  });
  it("ignores short/empty known secrets (no over-redaction of innocuous text)", () => {
    const msg = "exit code 7 at line 7";
    expect(redactSecrets(msg, ["7", ""])).toBe(msg);
  });

  it("redacts sk-ant- subscription keys", () => {
    const dirty = "credential sk-ant-oat-REAL-SUBSCRIPTION-TOKEN rejected upstream";
    const clean = redactSecrets(dirty);
    expect(clean).not.toContain("sk-ant-oat-REAL-SUBSCRIPTION-TOKEN");
    expect(clean).toContain("[REDACTED_KEY]");
  });

  it("redacts every repeated occurrence of the same secret (global flag)", () => {
    const token = "sk-proj-DEADBEEFDEADBEEF0000";
    const dirty = `first ${token} … and again ${token} end`;
    const clean = redactSecrets(dirty);
    expect(clean).not.toContain(token);
    expect(clean.match(/\[REDACTED_KEY\]/g)).toHaveLength(2);
  });
});

// ─── NDJSON stream reader (codex exec --json) ────────────────────────────────

/** Build a byte ReadableStream from an ordered list of string chunks. */
function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of readNdjsonLines(stream)) out.push(line);
  return out;
}

describe("readNdjsonLines", () => {
  it("splits a multi-line chunk into separate lines", async () => {
    expect(await collect(streamFrom(["a\nb\nc\n"]))).toEqual(["a", "b", "c"]);
  });

  it("reassembles a line split across two chunks", async () => {
    expect(await collect(streamFrom(["hel", "lo\n"]))).toEqual(["hello"]);
  });

  it("flushes an unterminated trailing line (no final newline)", async () => {
    expect(await collect(streamFrom(["a\nb"]))).toEqual(["a", "b"]);
  });

  it("skips blank / whitespace-only lines", async () => {
    expect(await collect(streamFrom(["a\n\n   \nb\n"]))).toEqual(["a", "b"]);
  });

  it("trims CRLF and surrounding whitespace from each line", async () => {
    expect(await collect(streamFrom(["  a  \r\n\tb\t\r\n"]))).toEqual(["a", "b"]);
  });

  it("yields nothing for an empty / whitespace-only stream", async () => {
    expect(await collect(streamFrom([]))).toEqual([]);
    expect(await collect(streamFrom(["   \n\n"]))).toEqual([]);
  });
});

describe("safeParseJson", () => {
  it("parses valid JSON into the typed object", () => {
    const parsed = safeParseJson<{ type: string; n: number }>('{"type":"turn.completed","n":3}');
    expect(parsed).toEqual({ type: "turn.completed", n: 3 });
  });

  it("returns null on malformed JSON instead of throwing", () => {
    expect(safeParseJson("{not json")).toBeNull();
    expect(safeParseJson("")).toBeNull();
  });
});

describe("buildCodexConfigToml", () => {
  it("emits a platform HTTP server with literal http_headers + approve", () => {
    const toml = buildCodexConfigToml({
      platform: {
        url: "http://127.0.0.1:3000/api/mcp/o/org_1",
        headers: { Cookie: "s=abc", "X-Org-Id": "org_1", "x-application-id": "app_1" },
      },
    });
    expect(toml).toContain("[mcp_servers.platform]");
    expect(toml).toContain('url = "http://127.0.0.1:3000/api/mcp/o/org_1"');
    expect(toml).toContain('default_tools_approval_mode = "approve"');
    expect(toml).toContain("startup_timeout_sec = 20");
    expect(toml).toContain("tool_timeout_sec = 120");
    expect(toml).toContain("[mcp_servers.platform.http_headers]");
    expect(toml).toContain('"Cookie" = "s=abc"');
    expect(toml).toContain('"X-Org-Id" = "org_1"');
    expect(toml).toContain('"x-application-id" = "app_1"');
  });

  it("escapes backslashes and quotes in header values", () => {
    const toml = buildCodexConfigToml({
      platform: { url: "http://x/y", headers: { H: 'a"b\\c' } },
    });
    expect(toml).toContain('"H" = "a\\"b\\\\c"');
  });

  it("never emits the rmcp [features] flag (unknown at codex 0.141)", () => {
    const toml = buildCodexConfigToml({ platform: { url: "http://x/y" } });
    expect(toml).not.toContain("experimental_use_rmcp_client");
    expect(toml).not.toContain("[features]");
  });

  it("honours custom timeouts and omits empty header/env tables", () => {
    const toml = buildCodexConfigToml({
      platform: { url: "http://x/y" },
      startupTimeoutSec: 5,
      toolTimeoutSec: 30,
    });
    expect(toml).toContain("startup_timeout_sec = 5");
    expect(toml).toContain("tool_timeout_sec = 30");
    expect(toml).not.toContain("http_headers");
  });

  it("returns an empty string when no servers are configured", () => {
    expect(buildCodexConfigToml({})).toBe("");
  });
});

describe("writeCodexConfig", () => {
  it("writes config.toml 0600 into the home", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-cfg-"));
    try {
      await writeCodexConfig({
        home,
        toml: buildCodexConfigToml({ platform: { url: "http://x/y" } }),
      });
      const path = join(home, "config.toml");
      expect(await readFile(path, "utf8")).toContain("[mcp_servers.platform]");
      const info = await stat(path);
      expect(info.mode & 0o777).toBe(0o600);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("is a no-op for an empty toml (no servers)", async () => {
    const home = await mkdtemp(join(tmpdir(), "codex-cfg-"));
    try {
      await writeCodexConfig({ home, toml: "" });
      expect(await dirExists(join(home, "config.toml"))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
