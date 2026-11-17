// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  dropSessionFromLists,
  historyQueryKey,
  sessionQueryKey,
  sessionSeedQuery,
  sessionsQueryKey,
  SESSIONS_QUERY_KEY,
  startTurnRow,
  sessionsSearchQueryKey,
  flattenSessions,
  patchSessionsCache,
  type SessionHistory,
  type SessionsCache,
  type SessionSummary,
} from "../src/ui/sessions.ts";
import { requestAnswering, transportOver } from "./fake-request.ts";

const row = (id: string): SessionSummary => ({
  id,
  title: null,
  generating: false,
  unread: false,
  updatedAt: "2026-09-02T10:00:00.000Z",
  spaceId: "spc_a",
  restricted: false,
  space_ids: ["spc_a"],
});

const twoPages = (): SessionsCache => ({
  pages: [
    { data: [row("a"), row("b")], hasMore: true },
    { data: [row("c")], hasMore: false },
  ],
  pageParams: [undefined, "b"],
});

describe("session-list cache", () => {
  it("flattens every loaded page, dropping a row the walk served twice", () => {
    const cache = twoPages();
    cache.pages[1]!.data.unshift(row("a"));
    expect(flattenSessions(cache).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("patches rows on every page and tells the head page apart", () => {
    const next = patchSessionsCache(twoPages(), (rows, first) =>
      first ? rows : rows.filter((s) => s.id !== "c"),
    );
    expect(next!.pages.map((p) => p.data.map((s) => s.id))).toEqual([["a", "b"], []]);
    expect(next!.pageParams).toEqual([undefined, "b"]);
  });

  it("leaves an absent cache absent unless seeded", () => {
    expect(patchSessionsCache(undefined, (rows) => rows)).toBeUndefined();
    const seeded = patchSessionsCache(undefined, (rows) => rows, row("new"));
    expect(flattenSessions(seeded!).map((s) => s.id)).toEqual(["new"]);
  });
});

describe("a deleted conversation", () => {
  const ids = (cache: SessionsCache | undefined) =>
    cache?.pages.flatMap((p) => p.data.map((s) => s.id));

  it("leaves every cached list: each space filter, the overview and a title search", async () => {
    const queryClient = new QueryClient();
    const keys = [
      sessionsQueryKey("spc_a"),
      sessionsQueryKey("spc_b"),
      sessionsQueryKey(null),
      sessionsSearchQueryKey(null, "plan"),
    ];
    for (const key of keys) queryClient.setQueryData(key, twoPages());

    await dropSessionFromLists(queryClient, "b");

    for (const key of keys) {
      expect(ids(queryClient.getQueryData<SessionsCache>(key))).toEqual(["a", "c"]);
    }
  });
});

describe("a turn starting, in the open filter's list", () => {
  const NOW = "2026-11-17T09:00:00.000Z";
  const ids = (cache: SessionsCache | undefined) =>
    cache?.pages.map((p) => p.data.map((s) => s.id));

  it("marks a listed conversation generating and moves it to the head", () => {
    const next = startTurnRow(twoPages(), { id: "c", created: null, now: NOW });
    expect(ids(next)).toEqual([["c", "a", "b"], []]);
    expect(next!.pages[0]!.data[0]).toMatchObject({
      generating: true,
      updatedAt: NOW,
      spaceId: "spc_a",
    });
  });

  it("makes the row of the conversation the turn creates, with its origin as its only space", () => {
    const next = startTurnRow(twoPages(), {
      id: "new",
      created: { originSpaceId: "spc_b", restricted: true },
      now: NOW,
    });
    expect(next!.pages[0]!.data[0]).toEqual({
      id: "new",
      title: null,
      unread: false,
      spaceId: "spc_b",
      restricted: true,
      space_ids: ["spc_b"],
      generating: true,
      updatedAt: NOW,
    });
    expect(
      startTurnRow(undefined, {
        id: "new",
        created: { originSpaceId: null, restricted: false },
        now: NOW,
      })!.pages[0]!.data[0]!.space_ids,
    ).toEqual([]);
  });

  it("leaves out an existing conversation the filter does not list", () => {
    const prev = twoPages();
    expect(startTurnRow(prev, { id: "elsewhere", created: null, now: NOW })).toBe(prev);
    expect(startTurnRow(undefined, { id: "elsewhere", created: null, now: NOW })).toBeUndefined();
  });
});

describe("a conversation's seed", () => {
  const history: SessionHistory = {
    ...row("chs_1"),
    messages: [],
    skills: { skillMode: "manual", pinnedSkills: ["@acme/tone"] },
    createdAt: "",
  };

  it("is keyed apart from the list prefix and the conversation's own entry, which signals refetch", () => {
    const key = historyQueryKey("org_1", "chs_1");
    expect(key.slice(0, 2)).not.toEqual([...SESSIONS_QUERY_KEY]);
    expect(key[0]).not.toBe("get");
  });

  it("reads through the conversation's entry: held there, it costs no request", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(sessionQueryKey("org_1", "chs_1"), history);
    const request = requestAnswering();
    const seed = await queryClient.fetchQuery(
      sessionSeedQuery(queryClient, transportOver(request), "chs_1"),
    );
    expect(seed).toEqual({ messages: [], skills: history.skills });
    expect(request.calls).toHaveLength(0);
  });

  it("is null for a conversation the caller does not have", async () => {
    const queryClient = new QueryClient();
    const request = requestAnswering(() => new Response(null, { status: 404 }));
    const seed = await queryClient.fetchQuery(
      sessionSeedQuery(queryClient, transportOver(request), "chs_gone"),
    );
    expect(seed).toBeNull();
    expect(request.calls.map((c) => c.path)).toEqual(["/api/orgs/org_1/chat/sessions/chs_gone"]);
  });
});
