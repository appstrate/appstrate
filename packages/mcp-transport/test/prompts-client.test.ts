// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createInProcessPair,
  createMcpHttpClient,
  createMcpServer,
  parseMcpPost,
  serveStatelessPost,
  wrapClient,
  type AppstratePromptProvider,
} from "../src/index.ts";
import { handlerFetch } from "../src/testing.ts";

const PROMPT = {
  name: "run-demo",
  title: "Demo",
  description: "Run the demo",
  arguments: [{ name: "request" }],
};

const prompts: AppstratePromptProvider = {
  list: () => [PROMPT],
  get: (name, args) => {
    if (name !== "run-demo") throw new McpError(ErrorCode.InvalidParams, "Unknown prompt");
    return {
      messages: [
        { role: "user" as const, content: { type: "text" as const, text: args.request ?? "" } },
      ],
    };
  },
};

/** A stateless HTTP server on the v1 SDK serving `provider`. */
function promptsFetch(provider: AppstratePromptProvider): typeof fetch {
  return handlerFetch(async (request) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = await request.arrayBuffer();
    return serveStatelessPost(
      createMcpServer([], undefined, { prompts: provider }),
      new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      }),
      new Request(request.url, { method: "POST", headers: request.headers, body }),
      parseMcpPost(body),
    );
  });
}

/** {@link promptsFetch}, with `method` answered by `page(params)` instead. */
function pagedFetch(
  method: "prompts/list" | "prompts/get",
  page: (params: Record<string, unknown>) => unknown,
): typeof fetch {
  const server = promptsFetch(prompts);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const text = await request.clone().text();
    const message = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (message.method !== method) return server(request);
    const result = page((message.params as Record<string, unknown>) ?? {});
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  }) as typeof fetch;
}

type HttpClient = Awaited<ReturnType<typeof createMcpHttpClient>>;

/** Runs `fn` against an HTTP client over `fetch`, closing it whatever happens. */
async function withHttpClient(
  fetch: typeof globalThis.fetch,
  fn: (client: HttpClient) => Promise<void>,
): Promise<void> {
  const client = await createMcpHttpClient("http://mcp.test/mcp", { era: "legacy", fetch });
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

describe("AppstrateMcpClient prompts", () => {
  it("lists and gets a prompt over an in-process pair", async () => {
    const pair = await createInProcessPair([], { prompts });
    const client = wrapClient(pair.client, pair);
    try {
      expect(await client.listPrompts()).toEqual({ prompts: [PROMPT] });
      const got = await client.getPrompt({ name: "run-demo", arguments: { request: "hi" } });
      expect(got.messages[0]!.content).toEqual({ type: "text", text: "hi" });
      const error = await client.getPrompt({ name: "run-other" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
    } finally {
      await client.close();
    }
  });

  it("lists and gets a prompt over HTTP", async () => {
    await withHttpClient(promptsFetch(prompts), async (client) => {
      expect(await client.listPrompts()).toEqual({ prompts: [PROMPT] });
      const got = await client.getPrompt({ name: "run-demo", arguments: { request: "go" } });
      expect(got.messages[0]!.content).toEqual({ type: "text", text: "go" });
    });
  });

  it("follows `nextCursor` to the last page", async () => {
    const seen: unknown[] = [];
    const second = { name: "run-other" };
    const fetch = pagedFetch("prompts/list", (params) => {
      seen.push(params);
      return params.cursor === "p2"
        ? { prompts: [second] }
        : { prompts: [PROMPT], nextCursor: "p2" };
    });
    await withHttpClient(fetch, async (client) => {
      expect(await client.listPrompts()).toEqual({ prompts: [PROMPT, second] });
      expect(seen).toEqual([{}, { cursor: "p2" }]);
    });
  });

  let n = 0;
  it.each([
    [
      "a page that is not a prompt list",
      () => ({ prompts: [{ title: "no name" }] }),
      "not a prompt list",
    ],
    [
      "a listing that never ends within 64 pages",
      () => ({ prompts: [PROMPT], nextCursor: `c${n++}` }),
      "did not end within 64 pages",
    ],
  ] as const)("refuses %s", async (_label, page, message) => {
    await withHttpClient(pagedFetch("prompts/list", page), async (client) => {
      await expect(client.listPrompts()).rejects.toThrow(message);
    });
  });

  it("refuses a prompts/get result that is not a prompt", async () => {
    await withHttpClient(
      pagedFetch("prompts/get", () => ({ messages: "nope" })),
      async (client) => {
        await expect(client.getPrompt({ name: "run-demo" })).rejects.toThrow("not a prompt");
      },
    );
  });

  it("fails its calls once closed", async () => {
    const pair = await createInProcessPair([], { prompts });
    const client = wrapClient(pair.client, pair);
    await client.close();
    await expect(client.listPrompts()).rejects.toThrow("MCP client is closed");
    await expect(client.getPrompt({ name: "run-demo" })).rejects.toThrow("MCP client is closed");
  });
});
