// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { loadHistory, stopSession } from "../src/ui/sessions.ts";

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

  it("walks every page by `since` so a long thread opens whole", async () => {
    const urls: string[] = [];
    const pages = [
      { messages: [{ id: "m1", seq: 7, content: { role: "user", parts: [] } }], hasMore: true },
      {
        messages: [{ id: "m2", seq: 42, content: { role: "assistant", parts: [] } }],
        hasMore: false,
      },
    ];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({ id: "chs_1", ...pages[urls.length - 1] });
    }) as typeof fetch;

    const msgs = await loadHistory(() => ({}), "chs_1");
    expect(msgs.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(urls).toEqual([
      "/api/chat/sessions/chs_1?limit=500",
      "/api/chat/sessions/chs_1?limit=500&since=7",
    ]);
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

describe("stopSession", () => {
  it("posts an authenticated explicit stop to the active conversation", async () => {
    let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    globalThis.fetch = (async (input, init) => {
      request = { input, init };
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    await stopSession(() => ({ "X-Org-Id": "org_1" }), "chs_1");

    expect(String(request?.input)).toBe("/api/chat/sessions/chs_1/stop");
    expect(request?.init?.method).toBe("POST");
    expect(request?.init?.credentials).toBe("include");
    expect(request?.init?.headers).toEqual({ "X-Org-Id": "org_1" });
  });

  it("throws when the server refuses the stop", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    await expect(stopSession(() => ({}), "chs_1")).rejects.toThrow("HTTP 500");
  });
});
