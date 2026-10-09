// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createMcpServer,
  parseMcpPost,
  serveStatelessPost,
  type AppstrateRequestExtra,
} from "../src/index.ts";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const call = (meta?: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "held", arguments: {}, ...(meta ? { _meta: meta } : {}) },
});

describe("parseMcpPost", () => {
  it("flags a request carrying a progressToken, alone or in a batch", () => {
    expect(parseMcpPost(encode(call({ progressToken: 0 })))?.requestsProgress).toBe(true);
    expect(parseMcpPost(encode([call(), call({ progressToken: "t" })]))?.requestsProgress).toBe(
      true,
    );
  });

  it("does not flag a request without one, nor a notification", () => {
    expect(parseMcpPost(encode(call()))?.requestsProgress).toBe(false);
    const notification = { jsonrpc: "2.0", method: "x", params: { _meta: { progressToken: 1 } } };
    expect(parseMcpPost(encode(notification))?.requestsProgress).toBe(false);
  });

  it("returns null for a body that is not JSON", () => {
    expect(parseMcpPost(new TextEncoder().encode("{nope"))).toBeNull();
  });
});

describe("serveStatelessPost", () => {
  /**
   * One tool held until `finish()`, on a fresh server + transport pair as the
   * endpoints build them, with the server's closes counted.
   */
  function setup(body: unknown) {
    let finish: () => void = () => {};
    const handled: { extra?: AppstrateRequestExtra } = {};
    const server = createMcpServer([
      {
        descriptor: { name: "held", inputSchema: { type: "object" } },
        handler: async (_args, extra) => {
          handled.extra = extra;
          await new Promise<void>((resolve) => {
            finish = resolve;
            extra.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { content: [{ type: "text", text: "done" }] };
        },
      },
    ]);
    let closes = 0;
    const close = server.close.bind(server);
    server.close = async () => {
      closes += 1;
      await close();
    };
    const bytes = encode(body);
    const post = parseMcpPost(bytes);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: !post?.requestsProgress,
    });
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: bytes,
    });
    return {
      serve: () => serveStatelessPost(server, transport, request, post),
      transport,
      handled,
      finish: () => finish(),
      closes: () => closes,
    };
  }

  /** Let the handler start. */
  const tick = () => new Promise((r) => setTimeout(r, 10));

  it("answers JSON and closes the pair at once without a progressToken", async () => {
    const s = setup(call());
    const pending = s.serve();
    await tick();
    s.finish();
    const res = await pending;
    expect(res.headers.get("content-type")).toStartWith("application/json");
    expect(s.closes()).toBe(1);
    expect(await res.json()).toMatchObject({ id: 1, result: {} });
  });

  it("streams SSE, opened at once, and closes the pair only once the stream is over", async () => {
    const s = setup(call({ progressToken: "tok" }));
    const res = await s.serve();
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    await tick();
    expect(s.closes()).toBe(0);
    s.finish();
    const text = await res.text();
    expect(text.startsWith(": stream open\n\n")).toBe(true);
    const frame = text.split("\n").find((line) => line.startsWith("data: "));
    expect(JSON.parse(frame!.slice("data: ".length))).toMatchObject({ id: 1, result: {} });
    expect(s.closes()).toBe(1);
  });

  it("closes the pair and aborts the tool when the client cancels the stream", async () => {
    const s = setup(call({ progressToken: "tok" }));
    const res = await s.serve();
    const reader = res.body!.getReader();
    await reader.read();
    await tick();
    await reader.cancel();
    expect(s.closes()).toBe(1);
    expect(s.handled.extra?.signal.aborted).toBe(true);
  });

  it("still closes the server when closing the transport fails", async () => {
    const s = setup(call());
    s.transport.close = () => Promise.reject(new Error("transport close failed"));
    const pending = s.serve();
    await tick();
    s.finish();
    await expect(pending).rejects.toThrow("transport close failed");
    expect(s.closes()).toBe(1);
  });
});
