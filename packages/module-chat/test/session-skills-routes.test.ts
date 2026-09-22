// SPDX-License-Identifier: Apache-2.0

/**
 * The per-conversation skill selection over HTTP: `PUT
 * /api/chat/sessions/:id/skills`, what the session DTOs carry back, and the
 * picker feed `GET /api/chat/skills`.
 *
 * Two properties are asserted rather than assumed, because both are the kind
 * that a route can appear to have while not having it:
 *
 *   - the PUT CREATES the session row when the client-minted id has none yet
 *     (pinning before the first message is the normal case), while still
 *     answering 404 on a foreign-tenant id — the same door `ensureSession`
 *     holds for a turn;
 *   - the pin set is a SET: replaced wholesale, deduped, and read back sorted,
 *     so nothing downstream can depend on insertion order (the index it feeds
 *     sits inside one prompt-cache block).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatSessionSkills } from "@appstrate/db/schema";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { VISIBILITY_META_NAMESPACE } from "../../../apps/api/src/lib/package-helpers.ts";
import { seedPackage } from "../../../apps/api/test/helpers/seed.ts";
import { setPlatformApp } from "../../../apps/api/src/lib/platform-app.ts";
import { mintSessionId } from "../src/session-id.ts";
import { PLATFORM_DEFAULT_SKILLS } from "../src/skills.ts";

const app = getTestApp();

// `GET /api/chat/skills` answers by DISPATCHING two platform reads back into
// the app (that is how the caller's own RBAC decides each half). The harness
// never runs boot(), so nothing has registered the app for in-process dispatch
// — same wiring as `view-as.test.ts` and the mcp integration suites.
setPlatformApp(app);

const LISTED_SKILL = "@chatpick/listed";
const UNLISTED_SKILL = "@chatpick/hidden";
/** One of the platform defaults, seeded as the SYSTEM package it ships as. */
const PLATFORM_SKILL = "@appstrate/copilot";

interface SessionDto {
  id: string;
  skill_discovery: string;
  pinned_skills?: string[];
}

interface SkillEntry {
  package_id: string;
  display_name: string;
  description: string;
  version: string | null;
  source: "platform" | "space";
}

describe("chat session skills", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatskills" });
  });

  function json(init: RequestInit & { headers?: Record<string, string> } = {}): RequestInit {
    return {
      ...init,
      headers: { ...authHeaders(ctx), "Content-Type": "application/json", ...init.headers },
    };
  }

  async function putSkills(
    sessionId: string,
    body: unknown,
    as: TestContext = ctx,
  ): Promise<Response> {
    return app.request(`/api/chat/sessions/${sessionId}/skills`, {
      method: "PUT",
      headers: { ...authHeaders(as), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function getSession(sessionId: string): Promise<SessionDto> {
    const res = await app.request(`/api/chat/sessions/${sessionId}`, json());
    expect(res.status).toBe(200);
    return (await res.json()) as SessionDto;
  }

  it("creates the session row for a client-minted id and persists mode + pins", async () => {
    // No POST /sessions first: the composer mints the id and the user pins a
    // skill before ever sending a message.
    const id = mintSessionId();
    const res = await putSkills(id, {
      skill_discovery: "manual",
      pinned_skills: ["@acme/b", "@acme/a"],
    });
    expect(res.status).toBe(204);

    const session = await getSession(id);
    expect(session.skill_discovery).toBe("manual");
    // Sorted on read, not in request order.
    expect(session.pinned_skills).toEqual(["@acme/a", "@acme/b"]);
  });

  it("replaces the whole set and dedupes what the client repeats", async () => {
    const id = mintSessionId();
    await putSkills(id, { skill_discovery: "auto", pinned_skills: ["@acme/a", "@acme/b"] });
    const replaced = await putSkills(id, {
      skill_discovery: "on_demand",
      pinned_skills: ["@acme/c", "@acme/c", "@acme/a"],
    });
    expect(replaced.status).toBe(204);

    const session = await getSession(id);
    expect(session.skill_discovery).toBe("on_demand");
    // `@acme/b` is gone (replace, not merge) and `@acme/c` appears once.
    expect(session.pinned_skills).toEqual(["@acme/a", "@acme/c"]);
  });

  it("answers 404 on another tenant's session id, and writes nothing", async () => {
    const stranger = await createTestContext({ orgSlug: "chatskills-other" });
    const id = mintSessionId();
    expect((await putSkills(id, { skill_discovery: "auto", pinned_skills: [] })).status).toBe(204);

    const res = await putSkills(id, { skill_discovery: "manual", pinned_skills: [] }, stranger);
    expect(res.status).toBe(404);
    expect((await getSession(id)).skill_discovery).toBe("auto");
  });

  it("refuses an unknown mode, a malformed id, and more pins than the ceiling", async () => {
    const id = mintSessionId();
    expect((await putSkills(id, { skill_discovery: "everything", pinned_skills: [] })).status).toBe(
      400,
    );
    expect(
      (await putSkills(id, { skill_discovery: "auto", pinned_skills: ["not-a-package-id"] }))
        .status,
    ).toBe(400);
    const tooMany = Array.from({ length: 21 }, (_, i) => `@acme/s${i}`);
    expect((await putSkills(id, { skill_discovery: "auto", pinned_skills: tooMany })).status).toBe(
      400,
    );
    // None of the three refusals created the session.
    expect((await app.request(`/api/chat/sessions/${id}`, json())).status).toBe(404);
  });

  it("carries the mode on the list route and the pins on the detail route", async () => {
    const created = await app.request(
      "/api/chat/sessions",
      json({ method: "POST", body: JSON.stringify({}) }),
    );
    expect(created.status).toBe(201);
    const fresh = (await created.json()) as SessionDto;
    // A brand-new conversation: the default mode and an explicitly empty set.
    expect(fresh.skill_discovery).toBe("auto");
    expect(fresh.pinned_skills).toEqual([]);

    await putSkills(fresh.id, { skill_discovery: "manual", pinned_skills: ["@acme/a"] });

    const list = (await (await app.request("/api/chat/sessions", json())).json()) as {
      data: SessionDto[];
    };
    const row = list.data.find((s) => s.id === fresh.id);
    expect(row?.skill_discovery).toBe("manual");
    // Deliberately absent from the page — one query per row is what that would cost.
    expect(row?.pinned_skills).toBeUndefined();

    expect((await getSession(fresh.id)).pinned_skills).toEqual(["@acme/a"]);
  });

  it("cascades the pins when the session is deleted", async () => {
    const id = mintSessionId();
    await putSkills(id, { skill_discovery: "auto", pinned_skills: ["@acme/a", "@acme/b"] });
    expect(await countPins(id)).toBe(2);

    const deleted = await app.request(`/api/chat/sessions/${id}`, json({ method: "DELETE" }));
    expect(deleted.status).toBe(204);
    expect(await countPins(id)).toBe(0);
  });
});

async function countPins(sessionId: string): Promise<number> {
  const rows = await db
    .select({ packageId: chatSessionSkills.packageId })
    .from(chatSessionSkills)
    .where(eq(chatSessionSkills.sessionId, sessionId));
  return rows.length;
}

describe("GET /api/chat/skills", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatpicker" });
    await createSkill(ctx, LISTED_SKILL, false);
    await createSkill(ctx, UNLISTED_SKILL, true);
    await seedPlatformSkill();
  });

  /**
   * The platform defaults ship as `unlisted` SYSTEM packages, which `boot()`
   * imports from `system-packages/*.afps` — and `getTestApp()` never boots. So
   * the row is written straight to the table, in the shape the archive would
   * produce: no org, no home space, `source: "system"`, and the visibility
   * marker that keeps it off every catalogue.
   *
   * Without this the platform half of the picker is empty for harness reasons
   * alone, and the route's whole exact-id path — the one that must offer a
   * default the catalogue deliberately hides — goes unasserted.
   */
  async function seedPlatformSkill(): Promise<void> {
    await seedPackage({
      id: PLATFORM_SKILL,
      orgId: null,
      homeSpaceId: null,
      source: "system",
      type: "skill",
      draftManifest: {
        name: PLATFORM_SKILL,
        version: "1.4.2",
        type: "skill",
        schema_version: "0.1",
        display_name: "Copilote",
        description: "Aide à composer un agent.",
        _meta: { [VISIBILITY_META_NAMESPACE]: { level: "unlisted" } },
      },
      draftContent: '---\nname: copilot\ndescription: "Aide."\n---\n\nCorps.',
    });
  }

  async function createSkill(c: TestContext, id: string, unlisted: boolean): Promise<void> {
    const res = await app.request("/api/packages/skills", {
      method: "POST",
      headers: { ...authHeaders(c), "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: {
          name: id,
          version: "2.3.0",
          type: "skill",
          schema_version: "0.1",
          display_name: `Skill ${id}`,
          description: "A picker fixture.",
          ...(unlisted ? { _meta: { [VISIBILITY_META_NAMESPACE]: { level: "unlisted" } } } : {}),
        },
        content: `---\nname: "${id.split("/")[1]}"\ndescription: "A picker fixture."\n---\n\nBody.`,
      }),
    });
    expect(res.status).toBe(201);
  }

  it("offers the space's listed skills and hides the unlisted one", async () => {
    const res = await app.request("/api/chat/skills", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const { skills } = (await res.json()) as { skills: SkillEntry[] };

    const listed = skills.find((s) => s.package_id === LISTED_SKILL);
    expect(listed).toEqual({
      package_id: LISTED_SKILL,
      display_name: `Skill ${LISTED_SKILL}`,
      description: "A picker fixture.",
      version: "2.3.0",
      source: "space",
    });
    // Unlisted is discoverability: off the catalogue, still resolvable by id.
    expect(skills.map((s) => s.package_id)).not.toContain(UNLISTED_SKILL);

    // The seeded default comes back on the PLATFORM half — unlisted, i.e. off
    // the catalogue the space half reads, which is exactly the case the
    // exact-id read exists for.
    expect(skills.filter((s) => s.source === "platform")).toEqual([
      {
        package_id: PLATFORM_SKILL,
        display_name: "Copilote",
        description: "Aide à composer un agent.",
        version: "1.4.2",
        source: "platform",
      },
    ]);
    // …and on that half ONLY: the space catalogue never shows it.
    expect(skills.filter((s) => s.package_id === PLATFORM_SKILL)).toHaveLength(1);
    // The two defaults with no row degrade to "nothing to offer" rather than
    // to a 500 — the path a deployment missing a system package takes.
    for (const id of PLATFORM_DEFAULT_SKILLS.filter((s) => s !== PLATFORM_SKILL)) {
      expect(skills.map((s) => s.package_id)).not.toContain(id);
    }
    // A listed space skill is listed once, and on the space half.
    expect(skills.filter((s) => s.package_id === LISTED_SKILL)).toHaveLength(1);
  });

  it("sorts by package id within each half", async () => {
    await createSkill(ctx, "@chatpick/aaa", false);
    const res = await app.request("/api/chat/skills", { headers: authHeaders(ctx) });
    const { skills } = (await res.json()) as { skills: SkillEntry[] };
    const space = skills.filter((s) => s.source === "space").map((s) => s.package_id);
    expect(space).toEqual([...space].sort());
    expect(space).toContain("@chatpick/aaa");
  });
});

/** The pin rows survive nothing but their session — asserted through the FK. */
describe("chat_session_skills is keyed by (session, package)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatskills-pk" });
  });

  it("keeps one row per pinned package after a repeated write", async () => {
    const id = mintSessionId();
    for (let i = 0; i < 3; i++) {
      const res = await app.request(`/api/chat/sessions/${id}/skills`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ skill_discovery: "auto", pinned_skills: ["@acme/a"] }),
      });
      expect(res.status).toBe(204);
    }
    const rows = await db
      .select({ packageId: chatSessionSkills.packageId })
      .from(chatSessionSkills)
      .where(and(eq(chatSessionSkills.sessionId, id), eq(chatSessionSkills.packageId, "@acme/a")));
    expect(rows).toHaveLength(1);
  });
});
