// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Bun compatibility probe tests (D31).
 *
 * The probe spawns a child process under `bun` and runs a minimal MCP
 * stdio handshake. We can exercise the success path with a hand-rolled
 * 30-line fake MCP server (good enough to answer `initialize` +
 * `tools/list`), and the failure paths via deterministic broken
 * scripts.
 *
 * The probe is best-effort and never throws — we assert it returns the
 * right `{ ok, reason }` shape in each scenario.
 */

import { describe, it, expect } from "bun:test";
import { probeBunCompat } from "../src/mcp-server-bundle/index.ts";

const ENC = new TextEncoder();

const SUCCESS_SCRIPT = `#!/usr/bin/env bun
// Minimal MCP stdio fake — answers initialize + tools/list and exits.
const stdin = process.stdin;
const stdout = process.stdout;
let buf = "";
stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "fake", version: "0.0.0" }, capabilities: {} } }) + "\\n");
    } else if (msg.method === "tools/list") {
      stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo" }, { name: "ping" }] } }) + "\\n");
    }
  }
});
`;

// Reports, via tool names, whether a secret env var leaked into the child
// and whether PATH (allowlisted) made it through.
const LEAK_PROBE_SCRIPT = `#!/usr/bin/env bun
const stdin = process.stdin;
const stdout = process.stdout;
let buf = "";
stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\\n");
    } else if (msg.method === "tools/list") {
      const leaked = process.env.SECRET_SHOULD_NOT_LEAK ? "leaked" : "clean";
      const hasPath = process.env.PATH ? "path" : "nopath";
      stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: leaked }, { name: hasPath }] } }) + "\\n");
    }
  }
});
`;

const CRASH_SCRIPT = `#!/usr/bin/env bun
process.stderr.write("simulated startup crash\\n");
process.exit(7);
`;

const HANG_SCRIPT = `#!/usr/bin/env bun
// Never answers — should time out.
setInterval(() => {}, 60_000);
`;

describe("probeBunCompat", () => {
  it("succeeds when the server answers initialize + tools/list", async () => {
    const result = await probeBunCompat(
      { "server/index.ts": ENC.encode(SUCCESS_SCRIPT) },
      "./server/index.ts",
      { timeoutMs: 8000 },
    );
    expect(result.ok).toBe(true);
    expect(result.toolCount).toBe(2);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it("fails (cleanly) when the server crashes on startup", async () => {
    const result = await probeBunCompat(
      { "server/index.ts": ENC.encode(CRASH_SCRIPT) },
      "./server/index.ts",
      { timeoutMs: 8000 },
    );
    expect(result.ok).toBe(false);
    expect(result.reason ?? "").toMatch(/exited|crash|7|simulated/);
  }, 15_000);

  it("times out (cleanly) when the server hangs", async () => {
    const result = await probeBunCompat(
      { "server/index.ts": ENC.encode(HANG_SCRIPT) },
      "./server/index.ts",
      { timeoutMs: 1500 },
    );
    expect(result.ok).toBe(false);
    expect(result.reason ?? "").toMatch(/timed out|timeout/);
  }, 8000);

  it("does not forward secret process.env vars to the spawned server", async () => {
    process.env.SECRET_SHOULD_NOT_LEAK = "super-secret-value";
    try {
      const result = await probeBunCompat(
        { "server/index.ts": ENC.encode(LEAK_PROBE_SCRIPT) },
        "./server/index.ts",
        { timeoutMs: 8000 },
      );
      expect(result.ok).toBe(true);
      // The secret must NOT reach the child; PATH (allowlisted) must.
      expect(result.toolNames).toContain("clean");
      expect(result.toolNames).not.toContain("leaked");
      expect(result.toolNames).toContain("path");
    } finally {
      delete process.env.SECRET_SHOULD_NOT_LEAK;
    }
  }, 15_000);

  it("fails (cleanly) when bun is not on PATH", async () => {
    const result = await probeBunCompat(
      { "server/index.ts": ENC.encode(SUCCESS_SCRIPT) },
      "./server/index.ts",
      { bunPath: "/nonexistent/path/to/bun", timeoutMs: 3000 },
    );
    expect(result.ok).toBe(false);
    expect(result.reason ?? "").toMatch(/ENOENT|spawn|not found|bun/);
  }, 8000);
});
