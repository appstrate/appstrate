// SPDX-License-Identifier: Apache-2.0

/**
 * Serving one stateless Streamable HTTP POST: `parseMcpPost` (the one parse,
 * and whether the call asked for progress), `releaseWhenSettled` (the SSE body
 * handed back, and the server released exactly once when it is over) and
 * `isSseResponse`.
 */

import { describe, it, expect } from "bun:test";
import { isSseResponse, parseMcpPost, releaseWhenSettled } from "../src/index.ts";

const OPEN = ": stream open\n\n";
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (chunk: Uint8Array | undefined) => new TextDecoder().decode(chunk);

/** `payload` as the request bytes; a string is sent verbatim, anything else as JSON. */
const bytes = (payload: unknown) =>
  encode(typeof payload === "string" ? payload : JSON.stringify(payload));
const asksProgress = (payload: unknown) => parseMcpPost(bytes(payload))?.requestsProgress;

const call = (meta?: Record<string, unknown>, id: unknown = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "t", arguments: {}, ...(meta ? { _meta: meta } : {}) },
});

describe("parseMcpPost", () => {
  it("hands the parsed payload on, for the SDK to validate", () => {
    const message = call({ progressToken: "tok" });
    expect(parseMcpPost(bytes(message))?.payload).toEqual(message);
    expect(parseMcpPost(bytes("null"))).toEqual({ payload: null, requestsProgress: false });
  });

  it("takes an ArrayBuffer as well as a Uint8Array", () => {
    const buffer = bytes(call({ progressToken: "tok" })).slice().buffer as ArrayBuffer;
    expect(parseMcpPost(buffer)?.requestsProgress).toBe(true);
  });

  it("returns null for a body that is not JSON", () => {
    expect(parseMcpPost(bytes("{nope"))).toBeNull();
    expect(parseMcpPost(new ArrayBuffer(0))).toBeNull();
  });

  it("flags a request whose progressToken is a string or an integer", () => {
    expect(asksProgress(call({ progressToken: "tok" }))).toBe(true);
    expect(asksProgress(call({ progressToken: 7 }))).toBe(true);
    expect(asksProgress(call({ progressToken: 0 }))).toBe(true);
  });

  it("does not flag a request without a usable token", () => {
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

/** An upstream SSE stream the test drives, and what it saw cancelled. */
function upstream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled: unknown[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
    cancel: (reason) => {
      cancelled.push(reason);
    },
  });
  return { stream, controller, cancelled };
}

/** Wrap `stream` as the SDK's SSE answer, counting releases. */
function wrap(stream: ReadableStream<Uint8Array>) {
  const counter = { releases: 0 };
  const sdkResponse = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const response = releaseWhenSettled(sdkResponse, async () => {
    counter.releases += 1;
  });
  return { response, counter };
}

describe("releaseWhenSettled", () => {
  it("opens with a comment, passes the stream through, and releases once when drained", async () => {
    const sdk = upstream();
    const { response, counter } = wrap(sdk.stream);
    expect(response.status).toBe(200);
    expect(isSseResponse(response)).toBe(true);
    expect(counter.releases).toBe(0);

    const reader = response.body!.getReader();
    expect(decode((await reader.read()).value)).toBe(OPEN);
    sdk.controller.enqueue(encode("event: message\ndata: 1\n\n"));
    sdk.controller.enqueue(encode("event: message\ndata: 2\n\n"));
    sdk.controller.close();
    expect(decode((await reader.read()).value)).toBe("event: message\ndata: 1\n\n");
    expect(decode((await reader.read()).value)).toBe("event: message\ndata: 2\n\n");
    expect((await reader.read()).done).toBe(true);
    expect(counter.releases).toBe(1);
  });

  it("releases once when the stream fails", async () => {
    const sdk = upstream();
    const { response, counter } = wrap(sdk.stream);
    const reader = response.body!.getReader();
    expect(decode((await reader.read()).value)).toBe(OPEN);
    sdk.controller.error(new Error("boom"));
    await expect(reader.read()).rejects.toThrow("boom");
    expect(counter.releases).toBe(1);
  });

  it("passes a client cancel upstream and releases once, even mid-read", async () => {
    const sdk = upstream();
    const { response, counter } = wrap(sdk.stream);
    const reader = response.body!.getReader();
    expect(decode((await reader.read()).value)).toBe(OPEN);
    // A read pending upstream when the client goes: the pull and the cancel
    // both end, and only one of them may release.
    const pending = reader.read();
    await reader.cancel("client gone");
    expect((await pending).done).toBe(true);
    await Bun.sleep(0);
    expect(sdk.cancelled).toEqual(["client gone"]);
    expect(counter.releases).toBe(1);
  });
});

describe("isSseResponse", () => {
  it("is false for a JSON answer and for one without a body", () => {
    const json = new Response("{}", { headers: { "content-type": "application/json" } });
    expect(isSseResponse(json)).toBe(false);
    const empty = new Response(null, { headers: { "content-type": "text/event-stream" } });
    expect(isSseResponse(empty)).toBe(false);
  });
});
