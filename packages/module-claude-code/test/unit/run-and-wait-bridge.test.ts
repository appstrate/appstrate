// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import {
  createRunAndWaitBridge,
  RUN_AND_WAIT_MCP_QUALIFIED_TOOL_NAME,
  RUN_AND_WAIT_MCP_SERVER_NAME,
} from "../../src/claude-agent/run-and-wait-bridge.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseChunkOutput(chunk: UIMessageChunk): unknown {
  if (chunk.type !== "tool-output-available") throw new Error("expected tool output");
  return parseMcpTextResult(chunk.output);
}

function parseMcpTextResult(result: unknown): unknown {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = content?.find((part) => part.type === "text")?.text;
  if (!text) return null;
  return JSON.parse(text);
}

async function waitForChunk(chunks: UIMessageChunk[]): Promise<void> {
  await waitForChunks(chunks, 1);
}

async function waitForChunks(chunks: UIMessageChunk[], count: number): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    if (chunks.length >= count) return;
    await Promise.resolve();
  }
  throw new Error(`expected ${count} chunks`);
}

function toolCallId(chunk: UIMessageChunk): string {
  if (chunk.type !== "tool-output-available") throw new Error("expected tool output");
  return chunk.toolCallId;
}

describe("RunAndWaitBridge", () => {
  test("pre-launches from the SDK tool permission and reuses that launch in the SDK tool", async () => {
    const chunks: UIMessageChunk[] = [];
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const responses = [
      jsonResponse({ id: "run_1", packageId: "@acme/writer", status: "pending" }),
      jsonResponse({
        id: "run_1",
        packageId: "@acme/writer",
        status: "success",
        result: { ok: true },
      }),
    ];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const res = responses.shift();
      if (!res) throw new Error("unexpected fetch");
      return res;
    };
    const bridge = createRunAndWaitBridge({
      origin: "https://test.local",
      headers: { authorization: "Bearer tok" },
      fetch: fetchImpl,
      write: (chunk) => chunks.push(chunk),
    });
    const input = { kind: "agent", scope: "@acme", name: "writer", input: { topic: "x" } };

    bridge.handleToolPermission(RUN_AND_WAIT_MCP_QUALIFIED_TOOL_NAME, input, "toolu_1");
    await waitForChunk(chunks);

    const final = await bridge.execute(input, { toolUseID: "toolu_1" });

    expect(bridge.mcpServer).toMatchObject({
      type: "sdk",
      name: RUN_AND_WAIT_MCP_SERVER_NAME,
    });
    expect(parseChunkOutput(chunks[0]!)).toEqual({
      id: "run_1",
      packageId: "@acme/writer",
      status: "pending",
      done: false,
    });
    expect(parseMcpTextResult(final)).toEqual({
      id: "run_1",
      packageId: "@acme/writer",
      status: "success",
      result: { ok: true },
      done: true,
    });
    expect(calls).toMatchObject([
      {
        url: "https://test.local/api/agents/%40acme/writer/run",
        method: "POST",
        body: { input: { topic: "x" } },
      },
      { url: "https://test.local/api/runs/run_1?wait=55", method: "GET" },
    ]);
  });

  test("keeps identical concurrent launches correlated by tool use id", async () => {
    const chunks: UIMessageChunk[] = [];
    const calls: string[] = [];
    const launched: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (init?.method === "POST") {
        const id = launched.length === 0 ? "run_a" : "run_b";
        launched.push(id);
        return jsonResponse({ id, packageId: "@acme/writer", status: "pending" });
      }
      const runId = new URL(url).pathname.split("/").pop();
      return jsonResponse({
        id: runId,
        packageId: "@acme/writer",
        status: "success",
        result: { run: runId },
      });
    };
    const bridge = createRunAndWaitBridge({
      origin: "https://test.local",
      headers: { authorization: "Bearer tok" },
      fetch: fetchImpl,
      write: (chunk) => chunks.push(chunk),
    });
    const input = { kind: "agent", scope: "@acme", name: "writer" };

    bridge.handleToolPermission(RUN_AND_WAIT_MCP_QUALIFIED_TOOL_NAME, input, "toolu_1");
    bridge.handleToolPermission(RUN_AND_WAIT_MCP_QUALIFIED_TOOL_NAME, input, "toolu_2");
    await waitForChunks(chunks, 2);

    const final2 = await bridge.execute(input, { toolUseID: "toolu_2" });
    const final1 = await bridge.execute(input, { toolUseID: "toolu_1" });

    expect(toolCallId(chunks[0]!)).toBe("toolu_1");
    expect(parseChunkOutput(chunks[0]!)).toMatchObject({ id: "run_a", done: false });
    expect(toolCallId(chunks[1]!)).toBe("toolu_2");
    expect(parseChunkOutput(chunks[1]!)).toMatchObject({ id: "run_b", done: false });
    expect(parseMcpTextResult(final2)).toMatchObject({
      id: "run_b",
      done: true,
      result: { run: "run_b" },
    });
    expect(parseMcpTextResult(final1)).toMatchObject({
      id: "run_a",
      done: true,
      result: { run: "run_a" },
    });
    expect(calls).toEqual([
      "https://test.local/api/agents/%40acme/writer/run",
      "https://test.local/api/agents/%40acme/writer/run",
      "https://test.local/api/runs/run_b?wait=55",
      "https://test.local/api/runs/run_a?wait=55",
    ]);
  });

  test("fails closed when identical pre-launches cannot be correlated", async () => {
    const chunks: UIMessageChunk[] = [];
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(String(input));
      if (init?.method === "POST") {
        return jsonResponse({ id: `run_${calls.length}`, status: "pending" });
      }
      throw new Error("should not poll an ambiguous launch");
    };
    const bridge = createRunAndWaitBridge({
      origin: "https://test.local",
      headers: { authorization: "Bearer tok" },
      fetch: fetchImpl,
      write: (chunk) => chunks.push(chunk),
    });
    const input = { kind: "agent", scope: "@acme", name: "writer" };

    bridge.handleToolPermission(RUN_AND_WAIT_MCP_QUALIFIED_TOOL_NAME, input, "toolu_1");
    bridge.handleToolPermission(RUN_AND_WAIT_MCP_QUALIFIED_TOOL_NAME, input, "toolu_2");
    await waitForChunks(chunks, 2);

    const final = await bridge.execute(input);

    expect(final.isError).toBe(true);
    expect(parseMcpTextResult(final)).toEqual({
      error: "run_and_wait could not correlate this SDK tool call to its pre-launched run.",
    });
    expect(calls).toEqual([
      "https://test.local/api/agents/%40acme/writer/run",
      "https://test.local/api/agents/%40acme/writer/run",
    ]);
  });

  test("falls back to launch-and-wait when no partial tool input was observed", async () => {
    const chunks: UIMessageChunk[] = [];
    const calls: string[] = [];
    const responses = [
      jsonResponse({ id: "run_2", status: "pending" }),
      jsonResponse({ id: "run_2", status: "success" }),
    ];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      const res = responses.shift();
      if (!res) throw new Error("unexpected fetch");
      return res;
    };
    const bridge = createRunAndWaitBridge({
      origin: "https://test.local",
      headers: { authorization: "Bearer tok" },
      fetch: fetchImpl,
      write: (chunk) => chunks.push(chunk),
    });

    const final = await bridge.execute({ kind: "agent", scope: "@acme", name: "writer" });

    expect(chunks).toEqual([]);
    expect(parseMcpTextResult(final)).toMatchObject({
      id: "run_2",
      status: "success",
      done: true,
    });
    expect(calls).toEqual([
      "https://test.local/api/agents/%40acme/writer/run",
      "https://test.local/api/runs/run_2?wait=55",
    ]);
  });
});
