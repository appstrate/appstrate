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

      expect(request.calls.map((c) => c.path.replace(/\?.*/, ""))).toEqual([
        "/api/orgs/org_1/chat/sessions",
        "/api/orgs/org_1/chat/sessions/chs_1",
        "/api/orgs/org_1/chat/sessions/chs_1",
        "/api/orgs/org_1/chat/sessions/chs_1",
        "/api/orgs/org_1/chat/sessions/chs_1/read",
        "/api/orgs/org_1/chat/sessions/chs_1/stop",
      ]);
    }
  });
});

describe("the conversation list as a filter", () => {
  it("reads every conversation in « Tous les espaces » and those that touched the selected space otherwise", async () => {
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

  it("keys an open conversation by the conversation alone, under the shell's typed-client key", () => {
    // The shell's realtime refetches this exact key on the conversation's session signal.
    expect(sessionQueryKey("org_1", "chs_1")).toEqual([
      "get",
      "/api/orgs/{orgId}/chat/sessions/{id}",
      { params: { path: { orgId: "org_1", id: "chs_1" } } },
    ]);
  });
});

describe("the origin space of a new conversation", () => {
  const acting = ["spc_a", "spc_b"];

  it("is the selected space when the chat acts there", () => {
    expect(selectedOriginSpaceId({ spaceId: "spc_b" }, acting)).toBe("spc_b");
  });

  it("is none in « Tous les espaces », in a space the chat cannot act in, and without a transport", () => {
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
    inlineRunsUseChatModel: false,
    skills: undefined,
  };

  it("carries the inline-run model switch as the user set it", () => {
    expect(turnBody({ ...base, creation: undefined })).toMatchObject({
      inline_runs_use_chat_model: false,
    });
    expect(turnBody({ ...base, inlineRunsUseChatModel: true, creation: undefined })).toMatchObject({
      inline_runs_use_chat_model: true,
    });
  });

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

  it("sends the skill selection on the turn that creates the conversation only", () => {
    const skills = { skillDiscovery: false, pins: ["@acme/a", "@acme/tone"] };
    const keys = (body: object) => Object.keys(body).filter((key) => /skill|pins/.test(key));
    expect(keys(turnBody({ ...base, creation: undefined, skills }))).toEqual([]);
    const creation = { spaceId: "spc_a", restricted: false };
    expect(keys(turnBody({ ...base, creation, skills: undefined }))).toEqual([]);
    expect(
      turnBody({ ...base, creation, skills: { skillDiscovery: true, pins: [] } }),
    ).toMatchObject({ skill_discovery: true });
    expect(
      keys(turnBody({ ...base, creation, skills: { skillDiscovery: true, pins: [] } })),
    ).toEqual(["skill_discovery"]);
    expect(turnBody({ ...base, creation, skills })).toMatchObject({
      skill_discovery: false,
      pins: ["@acme/a", "@acme/tone"],
    });
  });
});
