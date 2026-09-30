// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  flattenSessions,
  patchSessionsCache,
  type SessionsCache,
  type SessionSummary,
} from "../src/ui/sessions.ts";

const row = (id: string): SessionSummary => ({
  id,
  title: null,
  generating: false,
  unread: false,
  updatedAt: "2026-09-02T10:00:00.000Z",
});

const twoPages = (): SessionsCache => ({
  pages: [
    { data: [row("a"), row("b")], hasMore: true },
    { data: [row("c")], hasMore: false },
  ],
  pageParams: [null, "b"],
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
    expect(next!.pageParams).toEqual([null, "b"]);
  });

  it("leaves an absent cache absent unless seeded", () => {
    expect(patchSessionsCache(undefined, (rows) => rows)).toBeUndefined();
    const seeded = patchSessionsCache(undefined, (rows) => rows, row("new"));
    expect(flattenSessions(seeded!).map((s) => s.id)).toEqual(["new"]);
  });
});
