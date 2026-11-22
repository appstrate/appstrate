// SPDX-License-Identifier: Apache-2.0

/**
 * The skills the session DTOs carry back: each pin with its source and status. Turns write
 * them (`chat-stream-handler.test.ts`).
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
import { pinnedSkillsOf } from "../src/persistence.ts";

const app = getTestApp();

describe("pinnedSkillsOf", () => {
  it("gives each pin its source and status, null until evaluated", () => {
    expect(
      pinnedSkillsOf({
        pinnedSkills: ["@a/a", "@a/m", "@a/z"],
        assistantSkills: ["@a/m"],
        skillStatus: { "@a/a": "over_budget", "@a/m": "injected" },
      }),
    ).toEqual([
      { id: "@a/a", source: "user", status: "over_budget" },
      { id: "@a/m", source: "assistant", status: "injected" },
      { id: "@a/z", source: "user", status: null },
    ]);
  });

  it("reads a stored status outside the enum as not evaluated", () => {
    expect(
      pinnedSkillsOf({
        pinnedSkills: ["@a/a", "@a/b", "@a/c"],
        assistantSkills: [],
        skillStatus: { "@a/a": "loaded", "@a/b": 1, "@a/c": { injected: true } },
      }).map((pin) => pin.status),
    ).toEqual([null, null, null]);
  });
});

interface SessionDto {
  id: string;
  skill_discovery: boolean;
  skills: { id: string; source: string; status: string | null }[];
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
    const res = await app.request(`/api/orgs/${ctx.orgId}/chat/sessions/${sessionId}`, json());
    expect(res.status).toBe(200);
    return (await res.json()) as SessionDto;
  }

  it("carries the stored selection on the create, list and detail routes", async () => {
    const created = await app.request(
      `/api/orgs/${ctx.orgId}/chat/sessions`,
      json({ method: "POST", body: JSON.stringify({}) }),
    );
    expect(created.status).toBe(201);
    const fresh = (await created.json()) as SessionDto;
    expect(fresh.skill_discovery).toBe(true);
    expect(fresh.skills).toEqual([]);

    // Written by a turn in real use (`chat-stream-handler.test.ts`); here, the row.
    await db
      .update(chatSessions)
      .set({
        skillDiscovery: false,
        pinnedSkills: ["@acme/a", "@acme/b", "@acme/c"],
        assistantSkills: ["@acme/b"],
        skillStatus: { "@acme/a": "injected", "@acme/b": "over_budget" },
      })
      .where(eq(chatSessions.id, fresh.id));

    const list = (await (
      await app.request(`/api/orgs/${ctx.orgId}/chat/sessions`, json())
    ).json()) as {
      data: SessionDto[];
    };
    const row = list.data.find((s) => s.id === fresh.id);
    expect(row?.skill_discovery).toBe(false);
    const skills = [
      { id: "@acme/a", source: "user", status: "injected" },
      { id: "@acme/b", source: "assistant", status: "over_budget" },
      { id: "@acme/c", source: "user", status: null },
    ];
    expect(row?.skills).toEqual(skills);

    const detail = await getSession(fresh.id);
    expect(detail.skill_discovery).toBe(false);
    expect(detail.skills).toEqual(skills);
  });
});
