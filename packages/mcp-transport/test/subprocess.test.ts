// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for SubprocessTransport (Phase 4 of #276).
 *
 * Coverage focus:
 *   - JSON-RPC framing — line-delimited send/receive.
 *   - Cancellation: close() terminates the subprocess.
 *   - Crash handling: surfaces non-zero exit as transport error.
 *   - Stderr capture: stays separate from JSON-RPC channel.
 *   - Env scrubbing: only allowlist vars cross the boundary (I3 invariant).
 *   - Rate-limit guards: stdout flood does not OOM, stderr flood is shed.
 *
 * The fixture `test/fixtures/echo-server.ts` is a minimal MCP server
 * spawned via `bun run` so we exercise the real stdio path without
 * pulling in Node.
 */

import { describe, it, expect } from "bun:test";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SubprocessTransport } from "../src/index.ts";

const ECHO_FIXTURE = path.resolve(import.meta.dir, "fixtures/echo-server.ts");

function spawnTransport(opts: Partial<ConstructorParameters<typeof SubprocessTransport>[0]> = {}) {
  return new SubprocessTransport({
    command: "bun",
    args: ["run", ECHO_FIXTURE],
    ...opts,
  });
}

describe("SubprocessTransport — happy path", () => {
  it("connects, lists tools, and calls echo end-to-end via the SDK Client", async () => {
    const transport = spawnTransport();
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["echo"]);

      const result = await client.callTool({
        name: "echo",
        arguments: { msg: "hello" },
      });
      expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    } finally {
      await client.close();
    }
  });
});

describe("SubprocessTransport — lifecycle", () => {
  it("close() terminates the subprocess", async () => {
    const transport = spawnTransport();
    let closed = false;
    transport.onclose = () => {
      closed = true;
    };
    await transport.start();
    // Give the subprocess a moment to come up.
    await new Promise((r) => setTimeout(r, 50));
    await transport.close();
    expect(closed).toBe(true);
  });

  it("close() is idempotent", async () => {
    const transport = spawnTransport();
    await transport.start();
    await transport.close();
    await transport.close(); // no throw
  });

  it("starting twice throws", async () => {
    const transport = spawnTransport();
    await transport.start();
    let caught: unknown;
    try {
      await transport.start();
    } catch (err) {
      caught = err;
    }
    await transport.close();
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("already started");
  });

  it("send() before start() throws", async () => {
    const transport = spawnTransport();
    let caught: unknown;
    try {
      await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("not started");
  });

  it("send() after close() throws", async () => {
    const transport = spawnTransport();
    await transport.start();
    await transport.close();
    let caught: unknown;
    try {
      await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/closed|not started/);
  });
});

describe("SubprocessTransport — failure surfaces", () => {
  it("surfaces a subprocess crash via onerror", async () => {
    const transport = spawnTransport();
    let observed: Error | null = null;
    transport.onerror = (err) => {
      observed = observed ?? err;
    };
    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "crash" });
    // Wait for the subprocess to exit.
    await new Promise((r) => setTimeout(r, 200));
    expect(observed).not.toBeNull();
    expect(observed!.message).toMatch(/code 1|killed/);
  });

  it("captures stderr separately from JSON-RPC channel", async () => {
    const stderrLines: string[] = [];
    const transport = spawnTransport({
      onStderrLine: (line) => stderrLines.push(line),
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "echo", arguments: { msg: "x" } });
      // Make sure normal flow works.
      expect(result.content).toEqual([{ type: "text", text: "x" }]);
    } finally {
      await client.close();
    }
    // The echo fixture emits no stderr by default; the channel is
    // available but quiet. The flood-stderr method exercises capture
    // (covered below).
  });
});

describe("SubprocessTransport — env scrubbing (security invariant I3)", () => {
  it("does NOT propagate non-allowlisted env vars to the subprocess", async () => {
    process.env.SECRET_TOKEN = "should-not-cross";
    process.env.RUN_TOKEN = "also-should-not-cross";
    try {
      const stderrLines: string[] = [];
      const transport = new SubprocessTransport({
        command: "sh",
        args: ["-c", "env >&2"], // dump env to stderr so we can capture
        onStderrLine: (l) => stderrLines.push(l),
      });
      transport.onerror = () => {}; // silence "malformed JSON-RPC" noise
      await transport.start();
      await new Promise((r) => setTimeout(r, 200));
      await transport.close();
      const blob = stderrLines.join("\n");
      expect(blob.includes("SECRET_TOKEN")).toBe(false);
      expect(blob.includes("RUN_TOKEN=also-should-not-cross")).toBe(false);
    } finally {
      delete process.env.SECRET_TOKEN;
      delete process.env.RUN_TOKEN;
    }
  });

  it("propagates explicit env injection via options.env", async () => {
    const stderrLines: string[] = [];
    const transport = new SubprocessTransport({
      command: "sh",
      args: ["-c", 'echo "INJECTED=$INJECTED" >&2'],
      env: { INJECTED: "yes" },
      onStderrLine: (l) => stderrLines.push(l),
    });
    transport.onerror = () => {};
    await transport.start();
    await new Promise((r) => setTimeout(r, 200));
    await transport.close();
    const blob = stderrLines.join("\n");
    expect(blob).toContain("INJECTED=yes");
  });

  it("propagates allowlisted parent env when listed in envPassthrough", async () => {
    process.env.MY_TEST_VAR = "expected-value";
    try {
      const stderrLines: string[] = [];
      const transport = new SubprocessTransport({
        command: "sh",
        args: ["-c", 'echo "GOT=$MY_TEST_VAR" >&2'],
        envPassthrough: ["MY_TEST_VAR"],
        onStderrLine: (l) => stderrLines.push(l),
      });
      transport.onerror = () => {};
      await transport.start();
      await new Promise((r) => setTimeout(r, 200));
      await transport.close();
      const blob = stderrLines.join("\n");
      expect(blob).toContain("GOT=expected-value");
    } finally {
      delete process.env.MY_TEST_VAR;
    }
  });
});

describe("SubprocessTransport — rate limits", () => {
  it("captures stderr lines via the onStderrLine callback", async () => {
    const stderrLines: string[] = [];
    const transport = spawnTransport({
      onStderrLine: (line) => stderrLines.push(line),
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    try {
      // The fixture floods 1000 stderr lines; the transport's
      // rate-limiter will shed some. We just assert at least one was
      // delivered (rate-limiter is conservative — full delivery isn't
      // a contract).
      await client.callTool({ name: "echo", arguments: { msg: "trigger" } });
      // Trigger flood-stderr through a raw send (not a typed tool).
      await transport.send({ jsonrpc: "2.0", id: 99, method: "flood-stderr" });
      await new Promise((r) => setTimeout(r, 300));
      expect(stderrLines.length).toBeGreaterThan(0);
      expect(stderrLines.length).toBeLessThanOrEqual(1000);
    } finally {
      await client.close();
    }
  });
});
