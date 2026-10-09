// SPDX-License-Identifier: Apache-2.0

/**
 * `parseMcpPost`: the one parse of a POSTed MCP body, and which payloads the
 * endpoint answers over SSE. Only a REQUEST carrying `params._meta.progressToken`
 * (a string or an integer, the spec's `ProgressToken`) asks for progress; a body
 * that is not JSON is `null`, so the SDK reads it and answers its own `-32700`.
 */

import { describe, it, expect } from "bun:test";
import { parseMcpPost } from "../../../../src/modules/mcp/router.ts";

/** `payload` as the request bytes; a string is sent verbatim, anything else as JSON. */
function bytes(payload: unknown): ArrayBuffer {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new TextEncoder().encode(text).slice().buffer as ArrayBuffer;
}

const asksProgress = (payload: unknown) => parseMcpPost(bytes(payload))?.requestsProgress;

const call = (meta?: Record<string, unknown>, id: unknown = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "get_me", arguments: {}, ...(meta ? { _meta: meta } : {}) },
});

describe("parseMcpPost", () => {
  it("hands the parsed payload on, for the SDK to validate", () => {
    const message = call({ progressToken: "tok" });
    expect(parseMcpPost(bytes(message))?.payload).toEqual(message);
    expect(parseMcpPost(bytes("null"))).toEqual({ payload: null, requestsProgress: false });
  });

  it("is null for a body that is not JSON", () => {
    expect(parseMcpPost(bytes("{not json"))).toBeNull();
    expect(parseMcpPost(new ArrayBuffer(0))).toBeNull();
  });

  it("asks for progress on a request whose progressToken is a string or an integer", () => {
    expect(asksProgress(call({ progressToken: "tok" }))).toBe(true);
    expect(asksProgress(call({ progressToken: 7 }))).toBe(true);
    expect(asksProgress(call({ progressToken: 0 }))).toBe(true);
  });

  it("does not without a usable token", () => {
    expect(asksProgress(call())).toBe(false);
    expect(asksProgress(call({}))).toBe(false);
    expect(asksProgress(call({ progressToken: null }))).toBe(false);
    expect(asksProgress(call({ progressToken: 1.5 }))).toBe(false);
    expect(asksProgress(call({ progressToken: { nested: 1 } }))).toBe(false);
  });

  it("finds the token on any request of a batch", () => {
    expect(asksProgress([call(undefined, 1), call({ progressToken: "tok" }, 2)])).toBe(true);
    expect(asksProgress([call(undefined, 1), call(undefined, 2)])).toBe(false);
    expect(asksProgress([])).toBe(false);
  });

  it("ignores a token on a notification — it has no response to stream", () => {
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: { _meta: { progressToken: "tok" } },
    };
    expect(asksProgress(notification)).toBe(false);
    expect(asksProgress([notification])).toBe(false);
  });

  it("ignores a token on anything that is not a JSON-RPC request", () => {
    expect(asksProgress(42)).toBe(false);
    const { jsonrpc: _, ...noVersion } = call({ progressToken: "tok" });
    expect(asksProgress(noVersion)).toBe(false);
  });
});
