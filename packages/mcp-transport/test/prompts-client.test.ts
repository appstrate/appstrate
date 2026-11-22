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

/** {@link promptsFetch}, with `prompts/list` answered by `page(params)` instead. */
function pagedFetch(page: (params: Record<string, unknown>) => unknown): typeof fetch {
  const server = promptsFetch(prompts);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const text = await request.clone().text();
    const message = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (message.method !== "prompts/list") return server(request);
    const result = page((message.params as Record<string, unknown>) ?? {});
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  }) as typeof fetch;
}

describe("AppstrateMcpClient prompts", () => {
  it("lists and gets a prompt over an in-process pair", async () => {
    const pair = await createInProcessPair([], { prompts });
    const client = wrapClient(pair.client, pair);
    try {
      expect(await client.listPrompts()).toEqual({ prompts: [PROMPT] });
      const got = await client.getPrompt({ name: "run-demo", arguments: { request: "hi" } });
      expect(got.messages[0]!.content).toEqual({ type: "text", text: "hi" });
    } finally {
      await client.close();
    }
  });

  it("lists and gets a prompt over HTTP", async () => {
    const client = await createMcpHttpClient("http://mcp.test/mcp", {
      era: "legacy",
      fetch: promptsFetch(prompts),
    });
    try {
      expect(await client.listPrompts()).toEqual({ prompts: [PROMPT] });
      const got = await client.getPrompt({ name: "run-demo", arguments: { request: "go" } });
      expect(got.messages[0]!.content).toEqual({ type: "text", text: "go" });
    } finally {
      await client.close();
    }
  });

  it("refuses a name the server does not serve with its -32602", async () => {
    const pair = await createInProcessPair([], { prompts });
    const client = wrapClient(pair.client, pair);
    try {
      const error = await client.getPrompt({ name: "run-other" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
    } finally {
      await client.close();
    }
  });

  it("follows `nextCursor` to the last page", async () => {
    const seen: unknown[] = [];
    const second = { name: "run-other" };
    const client = await createMcpHttpClient("http://mcp.test/mcp", {
      era: "legacy",
      fetch: pagedFetch((params) => {
        seen.push(params);
        return params.cursor === "p2"
          ? { prompts: [second] }
          : { prompts: [PROMPT], nextCursor: "p2" };
      }),
    });
    try {
      expect(await client.listPrompts()).toEqual({ prompts: [PROMPT, second] });
      expect(seen).toEqual([{}, { cursor: "p2" }]);
    } finally {
      await client.close();
    }
  });

  it("refuses a server repeating its cursor, with no partial list", async () => {
    const client = await createMcpHttpClient("http://mcp.test/mcp", {
      era: "legacy",
      fetch: pagedFetch(() => ({ prompts: [PROMPT], nextCursor: "again" })),
    });
    try {
      await expect(client.listPrompts()).rejects.toThrow(
        "prompts/list repeated its cursor 'again'",
      );
    } finally {
      await client.close();
    }
  });

  it("refuses a page that is not a prompt list", async () => {
    const client = await createMcpHttpClient("http://mcp.test/mcp", {
      era: "legacy",
      fetch: pagedFetch(() => ({ prompts: [{ title: "no name" }] })),
    });
    try {
      await expect(client.listPrompts()).rejects.toThrow("not a prompt list");
    } finally {
      await client.close();
    }
  });

  it("fails its calls once closed", async () => {
    const pair = await createInProcessPair([], { prompts });
    const client = wrapClient(pair.client, pair);
    await client.close();
    await expect(client.listPrompts()).rejects.toThrow("MCP client is closed");
    await expect(client.getPrompt({ name: "run-demo" })).rejects.toThrow("MCP client is closed");
  });
});
