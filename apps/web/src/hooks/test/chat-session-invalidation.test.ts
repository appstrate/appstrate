// SPDX-License-Identifier: Apache-2.0

/**
 * `matchesChatSessionQuery` — the scoping rule behind the `chat_session_update`
 * invalidation. A turn emits ≥5 frames: each refetches the list, and only the
 * detail and the file list of its own conversation, never a run's file tab,
 * the gallery or another conversation's sidebar.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { matchesChatSessionQuery } from "../use-global-run-sync.ts";

const HEADER = { "X-Org-Id": "org_1" };
const SESSIONS_LIST_KEY = ["chat", "sessions"];
const detailKey = (id: string) => [
  "get",
  "/api/orgs/{orgId}/chat/sessions/{id}",
  { params: { path: { orgId: "org_1", id } } },
];
const filesForSessionKey = (id: string) => [
  "get",
  "/api/orgs/{orgId}/files",
  { params: { path: { orgId: "org_1" }, query: { context_chat_session_id: id, limit: 100 } } },
];
const ORG_FILES_KEY = ["get", "/api/orgs/{orgId}/files", { params: { path: { orgId: "org_1" } } }];
const FILES_FOR_RUN_KEY = [
  "get",
  "/api/files",
  { params: { query: { runId: "run_1", purpose: "agent_output" }, header: HEADER } },
];
const FILES_GALLERY_KEY = ["get", "/api/files", { params: { query: {}, header: HEADER } }];
const RUNS_KEY = ["get", "/api/runs", { params: { header: HEADER } }];

describe("matchesChatSessionQuery", () => {
  it("always includes the session list", () => {
    expect(matchesChatSessionQuery(SESSIONS_LIST_KEY, "chs_a")).toBe(true);
    expect(matchesChatSessionQuery(SESSIONS_LIST_KEY, undefined)).toBe(true);
  });

  it("scopes the session detail to the frame's session", () => {
    expect(matchesChatSessionQuery(detailKey("chs_a"), "chs_a")).toBe(true);
    expect(matchesChatSessionQuery(detailKey("chs_b"), "chs_a")).toBe(false);
  });

  it("scopes the file list to the page filtered on that session (negative control)", () => {
    expect(matchesChatSessionQuery(filesForSessionKey("chs_a"), "chs_a")).toBe(true);
    expect(matchesChatSessionQuery(filesForSessionKey("chs_b"), "chs_a")).toBe(false);
    expect(matchesChatSessionQuery(FILES_FOR_RUN_KEY, "chs_a")).toBe(false);
    expect(matchesChatSessionQuery(FILES_GALLERY_KEY, "chs_a")).toBe(false);
  });

  it("leaves the space file route alone, whatever its filter", () => {
    const spaceFiles = [
      "get",
      "/api/files",
      { params: { query: { context_chat_session_id: "chs_a" }, header: HEADER } },
    ];
    expect(matchesChatSessionQuery(spaceFiles, "chs_a")).toBe(false);
    expect(matchesChatSessionQuery(spaceFiles, undefined)).toBe(false);
  });

  it("falls back to the whole family when the session id is unknown (reconnect)", () => {
    expect(matchesChatSessionQuery(detailKey("chs_b"), undefined)).toBe(true);
    expect(matchesChatSessionQuery(filesForSessionKey("chs_b"), undefined)).toBe(true);
    expect(matchesChatSessionQuery(ORG_FILES_KEY, undefined)).toBe(true);
  });

  it("never touches queries outside the three chat families", () => {
    expect(matchesChatSessionQuery(RUNS_KEY, "chs_a")).toBe(false);
    expect(matchesChatSessionQuery(RUNS_KEY, undefined)).toBe(false);
    expect(matchesChatSessionQuery(["run", "run_1"], "chs_a")).toBe(false);
  });

  it("drives a predicate invalidation that leaves the other session's files fresh", async () => {
    const qc = new QueryClient();
    for (const key of [
      SESSIONS_LIST_KEY,
      detailKey("chs_a"),
      detailKey("chs_b"),
      filesForSessionKey("chs_a"),
      filesForSessionKey("chs_b"),
      FILES_FOR_RUN_KEY,
      RUNS_KEY,
    ]) {
      qc.setQueryData(key, []);
    }

    await qc.invalidateQueries({ predicate: (q) => matchesChatSessionQuery(q.queryKey, "chs_a") });

    const invalidated = (key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated;
    expect(invalidated(SESSIONS_LIST_KEY)).toBe(true);
    expect(invalidated(detailKey("chs_a"))).toBe(true);
    expect(invalidated(filesForSessionKey("chs_a"))).toBe(true);
    expect(invalidated(detailKey("chs_b"))).toBe(false);
    expect(invalidated(filesForSessionKey("chs_b"))).toBe(false);
    expect(invalidated(FILES_FOR_RUN_KEY)).toBe(false);
    expect(invalidated(RUNS_KEY)).toBe(false);
  });
});
