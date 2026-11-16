// SPDX-License-Identifier: Apache-2.0

/** One kind of conversation: the route every chat call takes, the filter that keys and names the space. */

import { describe, expect, it } from "bun:test";
import { chatPath, selectedOriginSpaceId, turnBody } from "../src/ui/chat-route.ts";
import {
  deleteSession,
  fetchSessionsPage,
  loadHistory,
  markSessionRead,
  renameSession,
  sessionQueryKey,
  sessionsQueryKey,
  sessionsSearchQueryKey,
  SESSIONS_QUERY_KEY,
  stopSession,
} from "../src/ui/sessions.ts";
import { fetchEnforcedSkills, fetchSkills } from "../src/ui/chat-skills.ts";
import { requestAnswering, transportOver } from "./fake-request.ts";

const headers = () => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a", "X-Chat-Locale": "fr" });

describe("the chat's routes", () => {
  it("serves everything from the organization's base, whatever the filter", () => {
    expect(chatPath({ orgId: "org_1" })).toBe("/api/orgs/org_1/chat");
    expect(chatPath({ orgId: "org_1" }, "/sessions/chs_1")).toBe(
      "/api/orgs/org_1/chat/sessions/chs_1",
    );
  });

  it("sends every chat REST call to the organization's base", async () => {
    const request = requestAnswering(() => Response.json({ data: [], hasMore: false }));
    for (const spaceId of [null, "spc_b"]) {
      request.calls.length = 0;
      const transport = transportOver(request, spaceId, headers);

      await fetchSessionsPage(transport, "chs_9", "budget");
      await loadHistory(transport, "chs_1").catch(() => {});
      await renameSession(transport, "chs_1", "Titre");
      await deleteSession(transport, "chs_1");
      await markSessionRead(transport, "chs_1");
      await stopSession(transport, "chs_1");
      await fetchEnforcedSkills(transport, "spc_a").catch(() => {});

      expect(request.calls.map((c) => c.path.replace(/\?.*/, ""))).toEqual([
        "/api/orgs/org_1/chat/sessions",
        "/api/orgs/org_1/chat/sessions/chs_1",
        "/api/orgs/org_1/chat/sessions/chs_1",
        "/api/orgs/org_1/chat/sessions/chs_1",
        "/api/orgs/org_1/chat/sessions/chs_1/read",
        "/api/orgs/org_1/chat/sessions/chs_1/stop",
        "/api/orgs/org_1/chat/enforced-skills",
      ]);
    }
  });
});

describe("the conversation list as a filter", () => {
  it("reads every conversation in « Vue d'ensemble » and those that touched the selected space otherwise", async () => {
    const request = requestAnswering(() => Response.json({ data: [], hasMore: false }));

    await fetchSessionsPage(transportOver(request, null), undefined);
    await fetchSessionsPage(transportOver(request, "spc_a"), undefined);
    await fetchSessionsPage(transportOver(request, "spc_a"), "chs_9", "budget");

    expect(request.calls.map((c) => c.path)).toEqual([
      "/api/orgs/org_1/chat/sessions",
      "/api/orgs/org_1/chat/sessions?spaceId=spc_a",
      "/api/orgs/org_1/chat/sessions?spaceId=spc_a&q=budget&startingAfter=chs_9",
    ]);
  });

  it("keys each filter apart, under the prefix the shell invalidates", () => {
    expect(sessionsQueryKey(null)).not.toEqual(sessionsQueryKey("spc_a"));
    expect(sessionsQueryKey("spc_a")).not.toEqual(sessionsQueryKey("spc_b"));
    for (const key of [
      sessionsQueryKey(null),
      sessionsQueryKey("spc_a"),
      sessionsSearchQueryKey("spc_a", "x"),
    ]) {
      expect(key.slice(0, SESSIONS_QUERY_KEY.length)).toEqual([...SESSIONS_QUERY_KEY]);
    }
  });

  it("keys an open conversation's history by the conversation alone: a filter change keeps it", () => {
    expect(sessionQueryKey("chs_1")).toEqual(["chat", "session", "chs_1"]);
  });
});

describe("the origin space of a new conversation", () => {
  const acting = ["spc_a", "spc_b"];

  it("is the selected space when the chat acts there", () => {
    expect(selectedOriginSpaceId({ spaceId: "spc_b" }, acting)).toBe("spc_b");
  });

  it("is none in « Vue d'ensemble », in a space the chat cannot act in, and without a transport", () => {
    expect(selectedOriginSpaceId({ spaceId: null }, acting)).toBeUndefined();
    expect(selectedOriginSpaceId({ spaceId: "spc_viewer" }, acting)).toBeUndefined();
    expect(selectedOriginSpaceId(undefined, acting)).toBeUndefined();
  });

  const base = {
    body: { trigger: "submit-message" },
    id: "chs_1",
    messages: [],
    generation: {},
    packageAuthoring: false,
    skills: undefined,
  };

  it("rides in the body of the turn that creates the conversation, with its limit", () => {
    expect(turnBody({ ...base, creation: { spaceId: "spc_a" } })).toMatchObject({
      id: "chs_1",
      spaceId: "spc_a",
    });
    expect(turnBody({ ...base, creation: { spaceId: "spc_a", restricted: true } })).toMatchObject({
      spaceId: "spc_a",
      restricted: true,
    });
  });

  it("is absent from the body of a turn of an existing conversation", () => {
    const body = turnBody({ ...base, creation: undefined });
    expect("spaceId" in body).toBe(false);
    expect("restricted" in body).toBe(false);
  });

  it("sends the skills only when the user changed them", () => {
    expect("skill_mode" in turnBody({ ...base, creation: undefined })).toBe(false);
    expect(
      turnBody({
        ...base,
        creation: undefined,
        skills: { skillMode: "auto", pinnedSkills: ["@acme/tone"] },
      }),
    ).toMatchObject({ skill_mode: "auto", pinned_skills: ["@acme/tone"] });
  });
});

describe("the skills picker's catalogue", () => {
  it("lists the skills of the acting spaces, one row per package", async () => {
    const row = (spaceId: string, id: string) => ({
      id,
      name: id,
      spaceId,
      version: "1.0.0",
      description: null,
    });
    const request = requestAnswering(() =>
      Response.json({
        object: "list",
        data: [
          row("spc_a", "@acme/tone"),
          row("spc_b", "@acme/tone"),
          row("spc_b", "@acme/seo"),
          row("spc_viewer", "@acme/hidden"),
        ],
      }),
    );

    const skills = await fetchSkills(transportOver(request, "spc_a"), ["spc_a", "spc_b"]);

    expect(request.calls.map((c) => c.path)).toEqual(["/api/orgs/org_1/packages/skills"]);
    expect(skills.map((s) => s.packageId)).toEqual(["@acme/tone", "@acme/seo"]);
  });
});
