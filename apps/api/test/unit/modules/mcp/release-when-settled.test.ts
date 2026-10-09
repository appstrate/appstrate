// SPDX-License-Identifier: Apache-2.0

/**
 * `releaseWhenSettled`, the SSE body the MCP router hands back: a first comment
 * (so Bun sends the headers at once), the SDK's stream unchanged, and the
 * server/transport released exactly once when the stream is over — drained,
 * failed, or cancelled by the client (the cancel reaching the SDK's stream).
 */

import { describe, it, expect } from "bun:test";
import { releaseWhenSettled } from "../../../../src/modules/mcp/router.ts";

const OPEN = ": stream open\n\n";
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (chunk: Uint8Array | undefined) => new TextDecoder().decode(chunk);

/** An inner SSE stream the test drives, and what it saw cancelled. */
function inner() {
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

/** Wrap `stream`, counting releases. */
function wrap(stream: ReadableStream<Uint8Array>) {
  const counter = { releases: 0 };
  const response = releaseWhenSettled(
    new Response(null, { status: 200, headers: { "content-type": "text/event-stream" } }),
    stream,
    async () => {
      counter.releases += 1;
    },
  );
  return { response, counter };
}

describe("releaseWhenSettled", () => {
  it("opens with a comment, passes the SDK stream through, and releases once when drained", async () => {
    const sdk = inner();
    const { response, counter } = wrap(sdk.stream);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

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

  it("releases once when the SDK stream fails", async () => {
    const sdk = inner();
    const { response, counter } = wrap(sdk.stream);
    const reader = response.body!.getReader();
    expect(decode((await reader.read()).value)).toBe(OPEN);
    sdk.controller.error(new Error("boom"));
    await expect(reader.read()).rejects.toThrow("boom");
    expect(counter.releases).toBe(1);
  });

  it("passes a client cancel to the SDK stream and releases once, even mid-read", async () => {
    const sdk = inner();
    const { response, counter } = wrap(sdk.stream);
    const reader = response.body!.getReader();
    expect(decode((await reader.read()).value)).toBe(OPEN);
    // A read pending on the SDK stream when the client goes: the pull and the
    // cancel both end, and only one of them may release.
    const pending = reader.read();
    await reader.cancel("client gone");
    expect((await pending).done).toBe(true);
    await Bun.sleep(0);
    expect(sdk.cancelled).toEqual(["client gone"]);
    expect(counter.releases).toBe(1);
  });
});
