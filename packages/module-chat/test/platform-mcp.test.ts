// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { wrapInvokeOperationTool, wrapRunAndWaitTool } from "../src/platform-mcp.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseToolResult(output: unknown): Record<string, unknown> {
  const content = (output as { content?: Array<{ type?: string; text?: string }> }).content;
  const first = content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected MCP text content");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function collectRunAndWait(
  fetchImpl: typeof fetch,
  args: unknown,
): Promise<{
  outputs: Record<string, unknown>[];
  originalCalled: boolean;
}> {
  let originalCalled = false;
  const tools = wrapRunAndWaitTool(
    {
      run_and_wait: {
        inputSchema: { type: "object", properties: {} },
        execute: () => {
          originalCalled = true;
          return { content: [{ type: "text", text: "{}" }] };
        },
      },
    } as never,
    {
      origin: "https://test.local",
      headers: { authorization: "Bearer tok", "x-org-id": "org_1", "x-application-id": "app_1" },
      fetch: fetchImpl,
    },
  ) as {
    run_and_wait: {
      execute: (rawArgs: unknown, options: { abortSignal?: AbortSignal }) => AsyncIterable<unknown>;
    };
  };

  const outputs: Record<string, unknown>[] = [];
  for await (const output of tools.run_and_wait.execute(args, {})) {
    outputs.push(parseToolResult(output));
  }
  return { outputs, originalCalled };
}

describe("platform MCP run_and_wait wrapper", () => {
  test("emits a preliminary run id, then the terminal run", async () => {
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

    const { outputs, originalCalled } = await collectRunAndWait(fetchImpl, {
      kind: "agent",
      scope: "@acme",
      name: "writer",
      input: { topic: "x" },
    });

    expect(originalCalled).toBe(false);
    expect(outputs).toEqual([
      { id: "run_1", packageId: "@acme/writer", status: "pending", done: false },
      {
        id: "run_1",
        packageId: "@acme/writer",
        status: "success",
        result: { ok: true },
        done: true,
      },
    ]);
    expect(calls).toMatchObject([
      {
        url: "https://test.local/api/agents/%40acme/writer/run",
        method: "POST",
        body: { input: { topic: "x" } },
      },
      { url: "https://test.local/api/runs/run_1?wait=55", method: "GET" },
    ]);
  });

  test("normalizes a run_and_wait input object encoded as a JSON string", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const responses = [
      jsonResponse({ id: "run_1", packageId: "@inline/r-1", status: "pending" }),
      jsonResponse({ id: "run_1", packageId: "@inline/r-1", status: "success" }),
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

    const { outputs } = await collectRunAndWait(
      fetchImpl,
      `{"kind":"inline","manifest":{"name":"@inline/t1"},"prompt":"Step 1
Step 2"}`,
    );

    expect(outputs.at(-1)).toMatchObject({ id: "run_1", status: "success", done: true });
    expect(calls[0]).toMatchObject({
      url: "https://test.local/api/runs/inline",
      method: "POST",
      body: { manifest: { name: "@inline/t1" }, prompt: "Step 1\nStep 2" },
    });
  });

  test("surfaces launch failures without polling", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return jsonResponse({ error: "no_published_version" }, 404);
    };

    const { outputs } = await collectRunAndWait(fetchImpl, {
      kind: "agent",
      scope: "@acme",
      name: "writer",
    });

    expect(outputs).toEqual([{ status: 404, body: { error: "no_published_version" } }]);
    expect(calls).toHaveLength(1);
  });

  test("validates arguments before dispatching", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("should not fetch");
    };

    const { outputs } = await collectRunAndWait(fetchImpl, { kind: "inline" });

    expect(outputs).toEqual([{ error: "`manifest` is required for kind:'inline'." }]);
  });
});

describe("platform MCP invoke_operation wrapper", () => {
  test("compacts listIntegrations results before they re-enter chat context", async () => {
    const tools = wrapInvokeOperationTool({
      invoke_operation: {
        execute: () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: 200,
                body: {
                  object: "list",
                  hasMore: false,
                  data: [
                    {
                      id: "@appstrate/gmail",
                      active: true,
                      block_user_connections: false,
                      manifest: {
                        display_name: "Gmail",
                        description: "Read Gmail messages",
                        default_tools: ["api_call"],
                        noisy: "x".repeat(10_000),
                      },
                    },
                  ],
                },
              }),
            },
          ],
        }),
      },
    } as never) as {
      invoke_operation: {
        execute: (rawArgs: unknown, options: { abortSignal?: AbortSignal }) => Promise<unknown>;
      };
    };

    const output = await tools.invoke_operation.execute({ operation_id: "listIntegrations" }, {});
    const parsed = parseToolResult(output);

    expect(parsed).toMatchObject({
      status: 200,
      compacted: true,
      data: [
        {
          id: "@appstrate/gmail",
          active: true,
          display_name: "Gmail",
          default_tools: ["api_call"],
        },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain("noisy");
  });
});
