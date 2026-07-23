// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { wrapRunAndWaitTool } from "../src/platform-mcp.ts";

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
  args: Record<string, unknown>,
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
  test("emits a preliminary run id, then the terminal run enriched with documents", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/run")) {
        return jsonResponse({ id: "run_1", packageId: "@acme/writer", status: "pending" });
      }
      if (url.includes("/api/documents")) {
        return jsonResponse({
          object: "list",
          data: [
            {
              id: "doc_1",
              uri: "document://doc_1",
              name: "report.html",
              mime: "text/html",
              size: 12,
            },
          ],
          hasMore: false,
        });
      }
      return jsonResponse({
        id: "run_1",
        packageId: "@acme/writer",
        status: "success",
        result: { ok: true },
      });
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
        documents: [
          {
            id: "doc_1",
            uri: "document://doc_1",
            name: "report.html",
            mime: "text/html",
            size: 12,
          },
        ],
      },
    ]);
    expect(calls).toMatchObject([
      {
        url: "https://test.local/api/agents/@acme/writer/run",
        method: "POST",
        body: { input: { topic: "x" } },
      },
      { url: "https://test.local/api/runs/run_1?wait=55", method: "GET" },
      {
        url: "https://test.local/api/documents?run_id=run_1&purpose=agent_output&limit=100",
        method: "GET",
      },
    ]);
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

  test("splits connect links out of streamed step payloads (typed connectOffer)", async () => {
    const url = "https://test.local/api/integrations/connect/start?token=SECRET";
    const responses = [
      jsonResponse({ id: "run_1", packageId: "@acme/writer", status: "pending" }),
      jsonResponse({
        id: "run_1",
        packageId: "@acme/writer",
        status: "success",
        result: { status: "auth_required", connect_url: url },
      }),
    ];
    const fetchImpl: typeof fetch = async () => {
      const res = responses.shift();
      if (!res) throw new Error("unexpected fetch");
      return res;
    };

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
      { origin: "https://test.local", headers: {}, fetch: fetchImpl },
    ) as {
      run_and_wait: {
        execute: (
          rawArgs: unknown,
          options: { abortSignal?: AbortSignal },
        ) => AsyncIterable<unknown>;
      };
    };

    const outputs: Array<Record<string, unknown>> = [];
    for await (const output of tools.run_and_wait.execute(
      { kind: "agent", scope: "@acme", name: "writer" },
      {},
    )) {
      outputs.push(output as Record<string, unknown>);
    }

    expect(originalCalled).toBe(false);
    const terminal = outputs.at(-1)!;
    // Model channel (content text) never carries the URL…
    const text = (terminal.content as Array<{ text: string }>)[0]!.text;
    expect(text).not.toContain("token=SECRET");
    expect(text).toContain("connect link hidden");
    // …the typed offer does.
    expect(terminal.connectOffer).toEqual({ connect_url: url });
  });

  test("validates arguments before dispatching", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("should not fetch");
    };

    const { outputs } = await collectRunAndWait(fetchImpl, { kind: "inline" });

    expect(outputs).toEqual([{ error: "`manifest` is required for kind:'inline'." }]);
  });
});
