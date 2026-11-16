// SPDX-License-Identifier: Apache-2.0

/** The chat scope: the route, the headers and the cache key every chat call derives from it. */

import { describe, expect, it } from "bun:test";
import {
  chatBase,
  chatHeaders,
  chatPath,
  chatScopeKey,
  transportForSession,
} from "../src/ui/scope.ts";
import {
  deleteSession,
  fetchSessionsPage,
  loadHistory,
  markSessionRead,
  renameSession,
  sessionQueryKey,
  sessionsQueryKey,
  SESSIONS_QUERY_KEY,
  stopSession,
} from "../src/ui/sessions.ts";
import { fetchEnforcedSkills, fetchSkills } from "../src/ui/chat-skills.ts";
import { requestAnswering, transportOver } from "./fake-request.ts";

const headers = () => ({ "X-Org-Id": "org_1", "X-Space-Id": "spc_a", "X-Chat-Locale": "fr" });
const org = { kind: "organization", orgId: "org_1" } as const;
const space = { kind: "space" } as const;

describe("chat scope", () => {
  it("serves a space's sessions from /api/chat and the organization's from its own base", () => {
    expect(chatBase(space)).toBe("/api/chat");
    expect(chatBase(org)).toBe("/api/orgs/org_1/chat");
    expect(chatPath({ scope: org }, "/sessions/chs_1")).toBe("/api/orgs/org_1/chat/sessions/chs_1");
  });

  it("drops X-Space-Id from an organization scope's chat calls only", () => {
    expect(chatHeaders({ getHeaders: headers, scope: space })["X-Space-Id"]).toBe("spc_a");
    const orgHeaders = chatHeaders({ getHeaders: headers, scope: org });
    expect(orgHeaders["X-Space-Id"]).toBeUndefined();
    expect(orgHeaders["X-Org-Id"]).toBe("org_1");
    expect(orgHeaders["X-Chat-Locale"]).toBe("fr");
  });

  it("keys the two kinds apart, under the prefix the shell invalidates", () => {
    const spaceKey = chatScopeKey({ getHeaders: headers, scope: space });
    const orgKey = chatScopeKey({ getHeaders: headers, scope: org });
    expect(spaceKey).toBe("spc_a");
    expect(orgKey).toBe("org:org_1");
    expect(sessionsQueryKey(orgKey)).not.toEqual(sessionsQueryKey(spaceKey));
    expect(sessionQueryKey(orgKey, "chs_1")).not.toEqual(sessionQueryKey(spaceKey, "chs_1"));
    for (const key of [sessionsQueryKey(orgKey), sessionsQueryKey(spaceKey)]) {
      expect(key.slice(0, SESSIONS_QUERY_KEY.length)).toEqual([...SESSIONS_QUERY_KEY]);
    }
  });

  it("waits for the space store in a space, never in an organization", () => {
    expect(chatScopeKey({ getHeaders: () => ({}), scope: space })).toBeNull();
    expect(chatScopeKey({ getHeaders: () => ({}), scope: org })).toBe("org:org_1");
    expect(chatScopeKey(undefined)).toBeNull();
  });
});

describe("the session routes of an organization scope", () => {
  it("sends every chat REST call to the organization's base", async () => {
    const request = requestAnswering(() => Response.json({ data: [], hasMore: false }));
    const transport = transportOver(request, org, headers);

    await fetchSessionsPage(transport, "chs_9", "budget");
    await loadHistory(transport, "chs_1").catch(() => {});
    await renameSession(transport, "chs_1", "Titre");
    await deleteSession(transport, "chs_1");
    await markSessionRead(transport, "chs_1");
    await stopSession(transport, "chs_1");
    await fetchEnforcedSkills(transport).catch(() => {});

    expect(request.calls.map((c) => c.path)).toEqual([
      "/api/orgs/org_1/chat/sessions?q=budget&startingAfter=chs_9",
      "/api/orgs/org_1/chat/sessions/chs_1",
      "/api/orgs/org_1/chat/sessions/chs_1",
      "/api/orgs/org_1/chat/sessions/chs_1",
      "/api/orgs/org_1/chat/sessions/chs_1/read",
      "/api/orgs/org_1/chat/sessions/chs_1/stop",
      "/api/orgs/org_1/chat/enforced-skills",
    ]);
  });

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
        data: [row("spc_a", "@acme/tone"), row("spc_b", "@acme/tone"), row("spc_b", "@acme/seo")],
      }),
    );

    const skills = await fetchSkills(transportOver(request, org), ["spc_a", "spc_b"]);

    expect(request.calls.map((c) => c.path)).toEqual(["/api/orgs/org_1/packages/skills"]);
    expect(skills.map((s) => s.packageId)).toEqual(["@acme/tone", "@acme/seo"]);
  });

  it("keeps the space routes for a space", async () => {
    const request = requestAnswering();
    await fetchSkills(transportOver(request, space));
    expect(request.calls[0]!.path).toBe("/api/packages/skills");
  });
});

describe("a write on a session of the organization's list", () => {
  it("goes through the session's own mount: a space session to its space, an organization session to the organization's", async () => {
    const request = requestAnswering();
    const transport = transportOver(request, org, headers);

    const inSpace = transportForSession(transport, { spaceId: "spc_b" });
    await renameSession(inSpace, "chs_1", "Titre");
    await deleteSession(inSpace, "chs_1");
    await deleteSession(transportForSession(transport, { spaceId: null }), "chs_2");

    expect(request.calls.map((c) => c.path)).toEqual([
      "/api/chat/sessions/chs_1",
      "/api/chat/sessions/chs_1",
      "/api/orgs/org_1/chat/sessions/chs_2",
    ]);
    // The space session names its own space, whatever the working one is; its body is kept.
    const [rename, del, orgDelete] = request.calls;
    expect(new Headers(rename!.init?.headers).get("X-Space-Id")).toBe("spc_b");
    expect(new Headers(rename!.init?.headers).get("Content-Type")).toBe("application/json");
    expect(rename!.init?.body).toBe(JSON.stringify({ title: "Titre" }));
    expect(new Headers(del!.init?.headers).get("X-Space-Id")).toBe("spc_b");
    expect(new Headers(orgDelete!.init?.headers).has("X-Space-Id")).toBe(false);
  });

  it("leaves a space's transport as it is", () => {
    const transport = transportOver(requestAnswering(), space, headers);
    expect(transportForSession(transport, { spaceId: "spc_a" })).toBe(transport);
  });
});
