// SPDX-License-Identifier: Apache-2.0

/**
 * The skills the session DTOs carry back (`pins`, `skill_discovery`), and the PATCH that sets them.
 * Turns write the verdicts (`chat-stream-handler.test.ts`).
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
import { setActiveStream } from "../src/resumable.ts";
import { NO_SKILL_STATUS, UNLIMITED_SCOPE } from "./turn-claim.ts";

const app = getTestApp();

describe("pinnedSkillsOf", () => {
  it("gives each pin its status and size, null until evaluated", () => {
    expect(
      pinnedSkillsOf({
        pinnedSkills: ["@a/a", "@a/m", "@a/u", "@a/z"],
        skillStatus: {
          "@a/a": { status: "over_budget", chars: 70_000 },
          "@a/m": { status: "injected", chars: 120 },
          "@a/u": { status: "unavailable", chars: null },
          // A pin dropped since: never shown.
          "@a/gone": { status: "injected", chars: 3 },
        },
      }),
    ).toEqual([
      { id: "@a/a", status: "over_budget", chars: 70_000 },
      { id: "@a/m", status: "injected", chars: 120 },
      { id: "@a/u", status: "unavailable", chars: null },
      { id: "@a/z", status: null, chars: null },
    ]);
  });

  it("reads an entry off the contract as not evaluated, and a bad size as unknown", () => {
    expect(
      pinnedSkillsOf({
        pinnedSkills: ["@a/a", "@a/b", "@a/c", "@a/d", "@a/e"],
        skillStatus: {
          "@a/a": { status: "loaded", chars: 1 },
          "@a/b": "injected",
          "@a/c": null,
          "@a/d": { status: "injected", chars: -1 },
          "@a/e": { status: "injected", chars: 1.5 },
        },
      }),
    ).toEqual([
      { id: "@a/a", status: null, chars: null },
      { id: "@a/b", status: null, chars: null },
      { id: "@a/c", status: null, chars: null },
      { id: "@a/d", status: "injected", chars: null },
      { id: "@a/e", status: "injected", chars: null },
    ]);
  });
});

interface SessionDto {
  id: string;
  skill_discovery: boolean;
  pins: { id: string; status: string | null; chars: number | null }[];
  updatedAt: string;
}

describe("chat session skills", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatskills" });
  });

  function json(init: RequestInit = {}, as: TestContext = ctx): RequestInit {
    return { ...init, headers: { ...authHeaders(as), "Content-Type": "application/json" } };
  }

  async function createSession(): Promise<SessionDto> {
    const created = await app.request(
      `/api/orgs/${ctx.orgId}/chat/sessions`,
      json({ method: "POST", body: JSON.stringify({}) }),
    );
    expect(created.status).toBe(201);
    return (await created.json()) as SessionDto;
  }

  async function getSession(sessionId: string): Promise<SessionDto> {
    const res = await app.request(`/api/orgs/${ctx.orgId}/chat/sessions/${sessionId}`, json());
    expect(res.status).toBe(200);
    return (await res.json()) as SessionDto;
  }

  const patchSkills = (sessionId: string, body: unknown, as: TestContext = ctx) =>
    app.request(
      `/api/orgs/${as.orgId}/chat/sessions/${sessionId}/skills`,
      json({ method: "PATCH", body: JSON.stringify(body) }, as),
    );

  async function stored(sessionId: string) {
    const [row] = await db
      .select({
        pinnedSkills: chatSessions.pinnedSkills,
        skillDiscovery: chatSessions.skillDiscovery,
        skillStatus: chatSessions.skillStatus,
      })
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId));
    return row;
  }

  it("carries the stored selection on the create, list and detail routes", async () => {
    const fresh = await createSession();
    expect(fresh.skill_discovery).toBe(true);
    expect(fresh.pins).toEqual([]);

    await db
      .update(chatSessions)
      .set({
        skillDiscovery: false,
        pinnedSkills: ["@acme/a", "@acme/b", "@acme/c"],
        skillStatus: {
          "@acme/a": { status: "injected", chars: 900 },
          "@acme/b": { status: "over_budget", chars: 64_001 },
        },
      })
      .where(eq(chatSessions.id, fresh.id));

    const list = (await (
      await app.request(`/api/orgs/${ctx.orgId}/chat/sessions`, json())
    ).json()) as { data: SessionDto[] };
    const row = list.data.find((s) => s.id === fresh.id);
    expect(row?.skill_discovery).toBe(false);
    const pins = [
      { id: "@acme/a", status: "injected", chars: 900 },
      { id: "@acme/b", status: "over_budget", chars: 64_001 },
      { id: "@acme/c", status: null, chars: null },
    ];
    expect(row?.pins).toEqual(pins);

    const detail = await getSession(fresh.id);
    expect(detail.skill_discovery).toBe(false);
    expect(detail.pins).toEqual(pins);
  });

  describe("PATCH …/sessions/:id/skills", () => {
    it("replaces the whole set, deduped and sorted, dropping the verdicts of the pins it drops", async () => {
      const { id, updatedAt } = await createSession();
      await db
        .update(chatSessions)
        .set({
          pinnedSkills: ["@acme/a", "@acme/b"],
          skillStatus: {
            "@acme/a": { status: "injected", chars: 10 },
            "@acme/b": { status: "unreadable", chars: null },
          },
        })
        .where(eq(chatSessions.id, id));

      const res = await patchSkills(id, { pins: ["@acme/c", "@acme/a", "@acme/c"] });
      expect(res.status).toBe(200);
      const dto = (await res.json()) as SessionDto;
      // The full resource, as the other session routes serve it.
      expect(dto).toMatchObject({ object: "chat_session", id, skill_discovery: true });
      expect(dto.pins).toEqual([
        { id: "@acme/a", status: "injected", chars: 10 },
        { id: "@acme/c", status: null, chars: null },
      ]);
      // A pin never reorders the sidebar.
      expect(dto.updatedAt).toBe(updatedAt);
      expect(await stored(id)).toEqual({
        pinnedSkills: ["@acme/a", "@acme/c"],
        skillDiscovery: true,
        skillStatus: { "@acme/a": { status: "injected", chars: 10 } },
      });

      // The empty set unpins everything.
      const cleared = await patchSkills(id, { pins: [] });
      expect(((await cleared.json()) as SessionDto).pins).toEqual([]);
      expect(await stored(id)).toMatchObject({ pinnedSkills: [], skillStatus: {} });
    });

    it("sets the discovery switch alone, leaving the pins and their verdicts", async () => {
      const { id } = await createSession();
      await db
        .update(chatSessions)
        .set({
          pinnedSkills: ["@acme/a"],
          skillStatus: { "@acme/a": { status: "injected", chars: 10 } },
        })
        .where(eq(chatSessions.id, id));
      const res = await patchSkills(id, { skill_discovery: false });
      expect(res.status).toBe(200);
      expect(await stored(id)).toEqual({
        pinnedSkills: ["@acme/a"],
        skillDiscovery: false,
        skillStatus: { "@acme/a": { status: "injected", chars: 10 } },
      });
    });

    it("refuses more than five pins, an empty body and an unknown field with a 400, writing nothing", async () => {
      const { id } = await createSession();
      for (const body of [
        { pins: ["@a/1", "@a/2", "@a/3", "@a/4", "@a/5", "@a/6"] },
        {},
        { pins: ["@a/1"], pin_skills: ["@a/2"] },
        { pins: ["not-a-package"] },
      ]) {
        const res = await patchSkills(id, body);
        expect(res.status).toBe(400);
      }
      expect(await stored(id)).toEqual({ pinnedSkills: [], skillDiscovery: true, skillStatus: {} });
    });

    it("answers 404 for a session of another member, and for an unknown one", async () => {
      const { id } = await createSession();
      const other = await createTestContext({ orgSlug: "chatskills-other" });
      expect((await patchSkills(id, { pins: ["@acme/a"] }, other)).status).toBe(404);
      expect((await patchSkills("chs_unknown", { pins: ["@acme/a"] })).status).toBe(404);
      expect(await stored(id)).toMatchObject({ pinnedSkills: [] });
    });

    it("is allowed while a turn is running, and leaves the turn's claim in place", async () => {
      const { id } = await createSession();
      await setActiveStream(id, "strm_live", UNLIMITED_SCOPE, NO_SKILL_STATUS);
      const res = await patchSkills(id, { pins: ["@acme/a"], skill_discovery: false });
      expect(res.status).toBe(200);
      const [row] = await db
        .select({ activeStreamId: chatSessions.activeStreamId })
        .from(chatSessions)
        .where(eq(chatSessions.id, id));
      expect(row?.activeStreamId).toBe("strm_live");
      expect(await stored(id)).toMatchObject({ pinnedSkills: ["@acme/a"], skillDiscovery: false });
    });
  });
});
