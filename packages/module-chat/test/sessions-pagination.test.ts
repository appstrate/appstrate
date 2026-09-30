// SPDX-License-Identifier: Apache-2.0

/**
 * The session list is bounded, and every row past the first page is
 * reachable: honest `hasMore`, a cursor in the body (`startingAfter=<session
 * id>`) and the RFC 5988 `Link` header. It used to stop at 100 with no cursor.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { chatSessions } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { walkLinkPages } from "../../../apps/api/test/helpers/pagination.ts";

const app = getTestApp();

interface SessionPage {
  data: { id: string }[];
  hasMore: boolean;
}

describe("chat session list pagination", () => {
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

    const pages = await walkLinkPages<SessionPage>(
      app,
      "/api/chat/sessions?limit=3",
      authHeaders(ctx),
    );
    expect(pages.map((p) => p.hasMore)).toEqual([true, true, false]);
    const viaLink = pages.flatMap((p) => p.data.map((s) => s.id));

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

    const rest = (
      await walkLinkPages<SessionPage>(
        app,
        `/api/chat/sessions?limit=3&startingAfter=${cursor}`,
        authHeaders(ctx),
      )
    ).flatMap((p) => p.data.map((s) => s.id));
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
});
