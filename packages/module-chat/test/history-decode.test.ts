// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { loadHistory, stopSession } from "../src/ui/sessions.ts";
import { requestAnswering } from "./fake-request.ts";

const json = (body: unknown) => () => Response.json(body);

describe("loadHistory decode", () => {
  it("reconstructs UIMessage[] as { id, ...content } in server order", async () => {
    const request = requestAnswering(
      json({
        id: "chs_1",
        skill_mode: "auto",
        pinned_skills: [],
        messages: [
          { id: "m1", content: { role: "user", parts: [{ type: "text", text: "hi" }] } },
          { id: "m2", content: { role: "assistant", parts: [{ type: "text", text: "yo" }] } },
        ],
      }),
    );

    const loaded = await loadHistory(request, "chs_1");
    expect(loaded?.messages).toEqual([
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "yo" }] },
    ] as never);
  });

  it("carries the session's skill selection as the server stores it", async () => {
    const request = requestAnswering(
      json({
        id: "chs_1",
        messages: [],
        skill_mode: "manual",
        pinned_skills: ["@scope/a", "@scope/b"],
      }),
    );

    const loaded = await loadHistory(request, "chs_1");
    expect(loaded?.skills).toEqual({
      skillMode: "manual",
      pinnedSkills: ["@scope/a", "@scope/b"],
    });
  });

  it("reports a conversation the caller does not have (404) as null, not as an empty one", async () => {
    const request = requestAnswering(() => new Response(null, { status: 404 }));
    expect(await loadHistory(request, "chs_gone")).toBeNull();
  });

  it("rethrows other refusals as the host raised them", async () => {
    const request = requestAnswering(() => new Response(null, { status: 500 }));
    await expect(loadHistory(request, "chs_x")).rejects.toMatchObject({ status: 500 });
  });
});

describe("stopSession", () => {
  it("posts an explicit stop to the active conversation", async () => {
    const request = requestAnswering(() => new Response(null, { status: 204 }));

    await stopSession(request, "chs_1");

    expect(request.calls).toHaveLength(1);
    expect(request.calls[0]?.path).toBe("/api/chat/sessions/chs_1/stop");
    expect(request.calls[0]?.init?.method).toBe("POST");
  });

  it("throws when the server refuses the stop", async () => {
    const request = requestAnswering(() => new Response(null, { status: 500 }));
    await expect(stopSession(request, "chs_1")).rejects.toMatchObject({ status: 500 });
  });
});
