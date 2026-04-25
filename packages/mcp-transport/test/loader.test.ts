// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `loadToolMcpServer` — the manifest-driven entry point that
 * wires §D4.2 (manifest schema) to the SubprocessTransport machinery
 * from Phase 4.
 *
 * The same `echo-server.ts` fixture as subprocess.test.ts is used so
 * we exercise the actual stdio path, not a mocked transport.
 */

import { describe, it, expect } from "bun:test";
import path from "node:path";
import { MCP_SERVER_RUNTIME, loadToolMcpServer } from "../src/index.ts";

const FIXTURE_DIR = path.resolve(import.meta.dir, "fixtures");

function manifest(overrides?: Record<string, unknown>) {
  return {
    runtime: MCP_SERVER_RUNTIME,
    entrypoint: "bun",
    args: ["run", path.resolve(FIXTURE_DIR, "echo-server.ts")],
    ...overrides,
  };
}

describe("loadToolMcpServer — happy path", () => {
  it("spawns, initializes, and exposes the SDK surface via AppstrateMcpClient", async () => {
    const client = await loadToolMcpServer(manifest(), { cwd: FIXTURE_DIR });
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.find((t) => t.name === "echo")).toBeDefined();
      const result = await client.callTool({ name: "echo", arguments: { msg: "ping" } });
      expect(result.content).toEqual([{ type: "text", text: "ping" }]);
    } finally {
      await client.close();
    }
  });

  it("forwards onStderrLine through to the SubprocessTransport (D4.5 hook)", async () => {
    const lines: string[] = [];
    const client = await loadToolMcpServer(manifest(), {
      cwd: FIXTURE_DIR,
      onStderrLine: (line) => lines.push(line),
    });
    try {
      // Trigger the fixture's flood-stderr method through the underlying
      // SDK Client so we know the hook is wired. Rate limiter sheds
      // most lines but at least the first ones land.
      await client.client.notification({ method: "flood-stderr" });
      await new Promise((r) => setTimeout(r, 50));
      expect(lines.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});

describe("loadToolMcpServer — failure modes", () => {
  it("rejects manifests that fail validation (no leaked subprocess)", async () => {
    await expect(loadToolMcpServer({ runtime: "wrong" }, { cwd: FIXTURE_DIR })).rejects.toThrow(
      /runtime/,
    );
  });

  it("rejects env entries outside the manifest allowlist (defence in depth)", async () => {
    await expect(
      loadToolMcpServer(manifest({ envAllowList: ["LANG"] }), {
        cwd: FIXTURE_DIR,
        env: { SECRET_KEY: "leaked" },
      }),
    ).rejects.toThrow(/envAllowList/);
  });

  it("times out when the subprocess never completes initialize", async () => {
    const slow = manifest({
      // Spawn a process that just sleeps — never sends any JSON-RPC.
      entrypoint: "sleep",
      args: ["10"],
      initTimeoutMs: 1000,
    });
    await expect(loadToolMcpServer(slow, { cwd: FIXTURE_DIR })).rejects.toThrow(/timed out/);
  });
});
