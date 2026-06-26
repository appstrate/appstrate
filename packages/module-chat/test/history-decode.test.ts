// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { loadHistory } from "../src/ui/sessions.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("loadHistory decode", () => {
  it("reconstructs UIMessage[] as { id, ...content } in server order", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "chs_1",
          messages: [
            { id: "m1", content: { role: "user", parts: [{ type: "text", text: "hi" }] } },
            { id: "m2", content: { role: "assistant", parts: [{ type: "text", text: "yo" }] } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const msgs = await loadHistory(() => ({}), "chs_1");
    expect(msgs).toEqual([
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "yo" }] },
    ] as never);
  });

  it("returns [] for a not-yet-persisted conversation (404)", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    expect(await loadHistory(() => ({}), "chs_new")).toEqual([]);
  });

  it("throws on other errors", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    await expect(loadHistory(() => ({}), "chs_x")).rejects.toThrow();
  });
});
