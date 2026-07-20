// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";

import { browserUseInteractionUrl, readConnectEventStream } from "./hosted-connect-sse";

describe("hosted connect browser event stream", () => {
  it("parses interaction and completion frames split across chunks", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: interaction\r\ndata: {"url":"https://live.browser-use.com/live/session"}\r\n',
          ),
        );
        controller.enqueue(encoder.encode('\r\nevent: complete\ndata: {"ok":true}\n\n'));
        controller.close();
      },
    });
    const events: Array<{ event: string; data: unknown }> = [];
    await readConnectEventStream(
      new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      (event) => {
        events.push(event);
      },
    );
    expect(events).toEqual([
      {
        event: "interaction",
        data: { url: "https://live.browser-use.com/live/session" },
      },
      { event: "complete", data: { ok: true } },
    ]);
  });

  it("rejects malformed event JSON", async () => {
    const response = new Response("event: interaction\ndata: {bad json}\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
    await expect(readConnectEventStream(response, () => undefined)).rejects.toThrow();
  });

  it("rejects interaction URLs outside Browser Use", () => {
    expect(() =>
      browserUseInteractionUrl("https://live.browser-use.com.attacker.example/session"),
    ).toThrow(/Invalid browser interaction URL/);
  });
});
