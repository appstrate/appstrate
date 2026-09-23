// SPDX-License-Identifier: Apache-2.0

/**
 * The session list and a session's message history are bounded, and every
 * row past the first page is reachable: honest `hasMore`, a cursor in the body
 * (`startingAfter=<session id>`, `since=<seq>`) and the RFC 5988 `Link` header.
 * The list used to stop at 100 with no cursor; the history had no bound at all.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { chatMessages, chatSessions } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { MESSAGES_MAX_LIMIT } from "../src/routes.ts";

const app = getTestApp();

interface SessionPage {
  data: { id: string }[];
  hasMore: boolean;
}
interface HistoryPage {
  messages: { id: string; seq: number }[];
  hasMore: boolean;
}

function nextPath(res: Response): string | null {
  const next = res.headers.get("Link")?.match(/<([^>]+)>; rel="next"/)?.[1];
  return next ? `${new URL(next).pathname}${new URL(next).search}` : null;
}

describe("chat pagination", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatorg" });
  });

  /** `count` sessions; pairs share `updatedAt` so the `id` tiebreak is exercised. */
  async function seedSessions(count: number): Promise<string[]> {
    const base = Date.parse("2026-09-01T00:00:00.000Z");
    const rows = Array.from({ length: count }, (_, i) => ({
      id: `chs_${String(i).padStart(32, "0")}`,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      updatedAt: new Date(base + Math.floor(i / 2) * 1000),
    }));
    await db.insert(chatSessions).values(rows);
    return rows.map((r) => r.id);
  }

  async function get(path: string) {
    const res = await app.request(path, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    return res;
  }

  it("walks every session exactly once, by Link header and by body cursor", async () => {
    const ids = await seedSessions(7);

    const viaLink: string[] = [];
    let path: string | null = "/api/chat/sessions?limit=3";
    while (path) {
      const res = await get(path);
      const body = (await res.json()) as SessionPage;
      viaLink.push(...body.data.map((s) => s.id));
      expect(Boolean(res.headers.get("Link"))).toBe(body.hasMore);
      path = nextPath(res);
    }

    const viaBody: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const q = cursor ? `&startingAfter=${cursor}` : "";
      const body = (await (await get(`/api/chat/sessions?limit=3${q}`)).json()) as SessionPage;
      viaBody.push(...body.data.map((s) => s.id));
      if (!body.hasMore) break;
      cursor = body.data.at(-1)!.id;
    }

    // Most recent activity first; ties broken by id, descending.
    const expected = [...ids].reverse();
    expect(viaLink).toEqual(expected);
    expect(viaBody).toEqual(expected);
  });

  it("never skips a row when the cursor session is bumped mid-walk", async () => {
    const ids = await seedSessions(6);
    const first = (await (await get("/api/chat/sessions?limit=3")).json()) as SessionPage;
    const cursor = first.data.at(-1)!.id;
    await db
      .update(chatSessions)
      .set({ updatedAt: new Date("2027-01-01T00:00:00Z") })
      .where(eq(chatSessions.id, cursor));

    const rest: string[] = [];
    let path: string | null = `/api/chat/sessions?limit=3&startingAfter=${cursor}`;
    while (path) {
      const res = await get(path);
      rest.push(...((await res.json()) as SessionPage).data.map((s) => s.id));
      path = nextPath(res);
    }
    const seen = new Set([...first.data.map((s) => s.id), ...rest]);
    expect(seen.size).toBe(ids.length);
  });

  it("rejects a cursor that is not one of the caller's sessions", async () => {
    await seedSessions(1);
    const res = await app.request("/api/chat/sessions?startingAfter=chs_nope", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { param?: string }).param).toBe("startingAfter");
  });

  it("caps the session page at 100", async () => {
    await seedSessions(101);
    const body = (await (await get("/api/chat/sessions")).json()) as SessionPage;
    expect(body.data).toHaveLength(100);
    expect(body.hasMore).toBe(true);
  });

  describe("session history", () => {
    async function seedHistory(count: number): Promise<string> {
      const [id] = await seedSessions(1);
      await db.insert(chatMessages).values(
        Array.from({ length: count }, (_, i) => ({
          sessionId: id!,
          messageId: `m${i}`,
          content: { role: "user", parts: [{ type: "text", text: `${i}` }] },
        })),
      );
      return id!;
    }

    it("pages the messages in seq order by `since`, with hasMore and Link", async () => {
      const id = await seedHistory(5);
      const seen: string[] = [];
      let path: string | null = `/api/chat/sessions/${id}?limit=2`;
      let pages = 0;
      while (path) {
        const res = await get(path);
        const body = (await res.json()) as HistoryPage;
        seen.push(...body.messages.map((m) => m.id));
        expect(Boolean(res.headers.get("Link"))).toBe(body.hasMore);
        path = nextPath(res);
        pages++;
      }
      expect(pages).toBe(3);
      expect(seen).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    });

    it("is bounded by default and at the maximum", async () => {
      const id = await seedHistory(MESSAGES_MAX_LIMIT + 1);
      const byDefault = (await (await get(`/api/chat/sessions/${id}`)).json()) as HistoryPage;
      expect(byDefault.messages).toHaveLength(100);
      expect(byDefault.hasMore).toBe(true);
      const atMax = (await (
        await get(`/api/chat/sessions/${id}?limit=${MESSAGES_MAX_LIMIT}`)
      ).json()) as HistoryPage;
      expect(atMax.messages).toHaveLength(MESSAGES_MAX_LIMIT);
      expect(atMax.hasMore).toBe(true);
      const tail = (await (
        await get(`/api/chat/sessions/${id}?since=${atMax.messages.at(-1)!.seq}`)
      ).json()) as HistoryPage;
      expect(tail.messages.map((m) => m.id)).toEqual([`m${MESSAGES_MAX_LIMIT}`]);
      expect(tail.hasMore).toBe(false);
    });
  });
});
