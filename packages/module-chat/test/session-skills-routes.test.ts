// SPDX-License-Identifier: Apache-2.0

/**
 * The skill selection the session DTOs carry back, and the listing the picker
 * reads. A turn writes the selection (`chat-stream-handler.test.ts`).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatSessions } from "@appstrate/db/schema";
import { mintSessionId } from "../src/session-id.ts";

const app = getTestApp();

interface SessionDto {
  id: string;
  skill_mode: string;
  pinned_skills: string[];
}

describe("chat session skills", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatskills" });
  });

  function json(init: RequestInit = {}): RequestInit {
    return { ...init, headers: { ...authHeaders(ctx), "Content-Type": "application/json" } };
  }

  async function getSession(sessionId: string): Promise<SessionDto> {
    const res = await app.request(`/api/chat/sessions/${sessionId}`, json());
    expect(res.status).toBe(200);
    return (await res.json()) as SessionDto;
  }

  it("reads the picker's four fields off the real skills listing", async () => {
    // `fetchSkills` hand-types this row; this is what keeps it honest.
    const created = await app.request("/api/packages/skills", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: {
          name: "@chatskills/tone",
          version: "1.2.0",
          type: "skill",
          schema_version: "0.1",
          display_name: "Tone",
          description: "Adjusts tone.",
        },
        content: '---\nname: tone\ndescription: "Adjusts tone."\n---\n\nBody.',
      }),
    });
    expect(created.status).toBe(201);
    const list = await app.request("/api/packages/skills", json());
    const rows = ((await list.json()) as { data: Record<string, unknown>[] }).data;
    expect(rows.find((row) => row.id === "@chatskills/tone")).toMatchObject({
      id: "@chatskills/tone",
      name: "Tone",
      description: "Adjusts tone.",
      version: "1.2.0",
    });
  });

  it("carries the stored selection on the create, list and detail routes", async () => {
    const created = await app.request(
      "/api/chat/sessions",
      json({ method: "POST", body: JSON.stringify({}) }),
    );
    expect(created.status).toBe(201);
    const fresh = (await created.json()) as SessionDto;
    expect(fresh.skill_mode).toBe("auto");
    expect(fresh.pinned_skills).toEqual([]);

    // Written by a turn in real use (`chat-stream-handler.test.ts`); here, the row.
    await db
      .update(chatSessions)
      .set({ skillMode: "manual", pinnedSkills: ["@acme/a"] })
      .where(eq(chatSessions.id, fresh.id));

    const list = (await (await app.request("/api/chat/sessions", json())).json()) as {
      data: SessionDto[];
    };
    const row = list.data.find((s) => s.id === fresh.id);
    expect(row?.skill_mode).toBe("manual");
    expect(row?.pinned_skills).toEqual(["@acme/a"]);

    const detail = await getSession(fresh.id);
    expect(detail.skill_mode).toBe("manual");
    expect(detail.pinned_skills).toEqual(["@acme/a"]);
  });

  it("serves no route that writes the selection outside a turn", async () => {
    const res = await app.request(
      `/api/chat/sessions/${mintSessionId()}/skills`,
      json({ method: "PUT", body: JSON.stringify({ skill_mode: "manual", pinned_skills: [] }) }),
    );
    expect(res.status).toBe(404);
  });
});
