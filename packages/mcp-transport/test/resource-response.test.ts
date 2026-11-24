// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { createMcpHttpClient } from "../src/client.ts";
import { handlerFetch, legacyMcpHandler, modernMcpHandler } from "../src/testing.ts";
import { boundResourceResponse } from "../src/resource-response.ts";

function responseFrom(chunks: string[], type: string, cancel?: () => void) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk !== undefined) controller.enqueue(encoder.encode(chunk));
        else if (!cancel) controller.close();
      },
      cancel,
    }),
    { headers: { "Content-Type": type } },
  );
}

it("bounds the streamed bytes before JSON parsing, including when the declared length is short", async () => {
  const stopped = Promise.withResolvers<void>();
  const upstream = responseFrom(['{"x":"', "éé", '"}'], "application/json", stopped.resolve);
  upstream.headers.set("content-length", "2");
  await expect(boundResourceResponse(upstream, "request", 8).json()).rejects.toThrow(
    "8-byte wire limit",
  );
  await stopped.promise;

  const allowed = responseFrom(['{"x":"', "é", '"}'], "application/json");
  expect(await boundResourceResponse(allowed, "request", 10).json()).toEqual({ x: "é" });
});

for (const end of ["\n", "\r", "\r\n"]) {
  it(`bounds each event of a shared SSE stream across ${JSON.stringify(end)} chunk boundaries`, async () => {
    const event = "data: 1" + end + end;
    const shared = responseFrom([...event.repeat(8)], "text/event-stream;charset=utf-8");
    expect(await boundResourceResponse(shared, "shared-stream", 10).text()).toBe(event.repeat(8));

    const lines = ["data: 1", "data: 2", ""].join(end);
    const tooWide = responseFrom([...lines], "text/event-stream");
    await expect(boundResourceResponse(tooWide, "shared-stream", 10).text()).rejects.toThrow(
      "10-byte wire limit",
    );
  });
}

it("preserves the redirect and URL metadata used by EventSource", async () => {
  const stream = responseFrom(["data: ok\n\n"], "text/event-stream");
  Object.defineProperties(stream, {
    url: { value: "https://example.org/stream" },
    redirected: { value: true },
  });
  const bounded = boundResourceResponse(stream, "request", 16);
  expect(bounded.url).toBe(stream.url);
  expect(bounded.redirected).toBe(true);
  expect(await bounded.text()).toBe("data: ok\n\n");
});

it("bounds a complete POST response or HTTP refusal even when it announces SSE", async () => {
  const stream = "data: 1\n\n".repeat(3);
  const response = (status: number) =>
    new Response(stream, { status, headers: { "Content-Type": "text/event-stream" } });
  await expect(boundResourceResponse(response(200), "request", 10).text()).rejects.toThrow(
    "wire limit",
  );
  await expect(boundResourceResponse(response(403), "shared-stream", 10).text()).rejects.toThrow(
    "wire limit",
  );
});

for (const era of ["legacy", "modern"] as const) {
  it(`reads a bounded resource through the ${era} HTTP protocol`, async () => {
    const handshake = era === "modern" ? modernMcpHandler() : legacyMcpHandler();
    const uri = "example://report";
    let version = 0;
    const client = await createMcpHttpClient(`https://resource-${era}.invalid/mcp`, {
      fetch: handlerFetch(async (request) => {
        if (request.method !== "POST") return handshake(request);
        const rpc = (await request.clone().json()) as { method: string; id: number };
        if (rpc.method === "resources/read") {
          const packet = JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              ...(era === "modern" && {
                resultType: "complete",
                ttlMs: 60_000,
                cacheScope: "private",
              }),
              contents: [{ uri, text: String(++version) }],
            },
          });
          return era === "modern"
            ? responseFrom([packet], "application/json")
            : responseFrom(["event: message\n", "data: " + packet + "\n\n"], "text/event-stream");
        }
        const response = await handshake(request);
        if (response.ok && (rpc.method === "initialize" || rpc.method === "server/discover")) {
          const packet = (await response.json()) as {
            result: { capabilities: { resources?: object } };
          };
          packet.result.capabilities.resources = {};
          return Response.json(packet, response);
        }
        return response;
      }),
    });
    try {
      expect(client.getProtocol()?.era).toBe(era);
      for (const text of ["1", "2"]) {
        const result = await client.readResource({ uri });
        expect(result.contents).toEqual([{ uri, text }]);
      }
    } finally {
      await client.close();
    }
  });
}
