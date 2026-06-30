// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import {
  createRunAndWaitBridge,
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
  for (let i = 0; i < 10; i += 1) {
    if (chunks.length > 0) return;
    await Promise.resolve();
  }
  throw new Error("expected chunk");
}

describe("RunAndWaitBridge", () => {
  test("pre-launches from the streamed tool input and reuses that launch in the SDK tool", async () => {
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

    bridge.handleChunk({
      type: "tool-input-available",
      toolCallId: "toolu_1",
      toolName: "run_and_wait",
      input,
    } as UIMessageChunk);
    await waitForChunk(chunks);

    const final = await bridge.execute(input);

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
      { url: "https://test.local/api/runs/run_1?wait=true", method: "GET" },
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
      "https://test.local/api/runs/run_2?wait=true",
    ]);
  });
});
