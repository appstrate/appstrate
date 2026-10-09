// SPDX-License-Identifier: Apache-2.0

/**
 * `requestsProgress`: which POSTed JSON-RPC payloads the MCP endpoint answers
 * over SSE. Only a REQUEST carrying `params._meta.progressToken` (a string or
 * an integer, the spec's `ProgressToken`) qualifies; everything else, invalid
 * input included, stays on the JSON response.
 */

import { describe, it, expect } from "bun:test";
import { requestsProgress } from "../../../../src/modules/mcp/router.ts";

/** `payload` as the request bytes; a string is sent verbatim, anything else as JSON. */
function bytes(payload: unknown): ArrayBuffer {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new TextEncoder().encode(text).slice().buffer as ArrayBuffer;
}

const call = (meta?: Record<string, unknown>, id: unknown = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "get_me", arguments: {}, ...(meta ? { _meta: meta } : {}) },
});

describe("requestsProgress", () => {
  it("accepts a request whose progressToken is a string or an integer", () => {
    expect(requestsProgress(bytes(call({ progressToken: "tok" })))).toBe(true);
    expect(requestsProgress(bytes(call({ progressToken: 7 })))).toBe(true);
    expect(requestsProgress(bytes(call({ progressToken: 0 })))).toBe(true);
  });

  it("refuses a request without a usable token", () => {
    expect(requestsProgress(bytes(call()))).toBe(false);
    expect(requestsProgress(bytes(call({})))).toBe(false);
    expect(requestsProgress(bytes(call({ progressToken: null })))).toBe(false);
    expect(requestsProgress(bytes(call({ progressToken: 1.5 })))).toBe(false);
    expect(requestsProgress(bytes(call({ progressToken: { nested: 1 } })))).toBe(false);
  });

  it("finds the token on any request of a batch", () => {
    const plain = call(undefined, 1);
    const asking = call({ progressToken: "tok" }, 2);
    expect(requestsProgress(bytes([plain, asking]))).toBe(true);
    expect(requestsProgress(bytes([plain, call(undefined, 2)]))).toBe(false);
    expect(requestsProgress(bytes([]))).toBe(false);
  });

  it("ignores a token on a notification — it has no response to stream", () => {
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: { _meta: { progressToken: "tok" } },
    };
    expect(requestsProgress(bytes(notification))).toBe(false);
    expect(requestsProgress(bytes([notification]))).toBe(false);
  });

  it("leaves anything that is not a JSON-RPC request to the SDK", () => {
    expect(requestsProgress(bytes("{not json"))).toBe(false);
    expect(requestsProgress(new ArrayBuffer(0))).toBe(false);
    expect(requestsProgress(bytes("null"))).toBe(false);
    expect(requestsProgress(bytes("42"))).toBe(false);
    const { jsonrpc: _, ...noVersion } = call({ progressToken: "tok" });
    expect(requestsProgress(bytes(noVersion))).toBe(false);
  });
});
