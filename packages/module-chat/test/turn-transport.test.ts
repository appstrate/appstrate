// SPDX-License-Identifier: Apache-2.0

/**
 * The turn transport reads its route when a request leaves, not when it is built: `useChat` keeps
 * the first transport it sees for a conversation, which can be built before the host's is ready.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createTurnTransport } from "../src/ui/chat-route.ts";
import type { ChatTransport } from "../src/ui/runtime-context.ts";
import { transportOver } from "./fake-request.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function capture(): string[] {
  const urls: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("");
    },
    { preconnect: realFetch.preconnect },
  );
  return urls;
}

describe("the turn transport", () => {
  it("sends to the organization of the transport known when the turn leaves", async () => {
    const host: { transport?: ChatTransport } = {};
    const turns = createTurnTransport({
      getTransport: () => host.transport,
      headers: () => ({}),
      body: ({ id }) => ({ id }),
    });
    // The host's transport arrives after the conversation's was built.
    host.transport = transportOver(async () => new Response());
    const urls = capture();

    await turns.sendMessages({
      chatId: "chs_1",
      messages: [],
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
    });
    await turns.reconnectToStream({ chatId: "chs_1" });

    expect(urls).toEqual(["/api/orgs/org_1/chat", "/api/orgs/org_1/chat/sessions/chs_1/stream"]);
  });
});
