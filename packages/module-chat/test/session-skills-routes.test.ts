// SPDX-License-Identifier: Apache-2.0

/**
 * `PUT /api/chat/sessions/:id/skills` and the selection the session DTOs carry
 * back. The PUT creates the row for a client-minted id yet still 404s a
 * foreign-tenant one; pins are replaced wholesale, deduped and stored sorted.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { mintSessionId } from "../src/session-id.ts";
import { MAX_PINNED_SKILLS } from "../src/skills.ts";

const app = getTestApp();

interface SessionDto {
  id: string;
  skill_catalogue: boolean;
  pinned_skills: string[];
  updatedAt: string;
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

  it("creates the session row for a client-minted id and persists the selection", async () => {
    const id = mintSessionId();
    const res = await putSkills(id, {
      skill_catalogue: false,
      pinned_skills: ["@acme/b", "@acme/a"],
    });
    expect(res.status).toBe(204);

    const session = await getSession(id);
    expect(session.skill_catalogue).toBe(false);
    expect(session.pinned_skills).toEqual(["@acme/a", "@acme/b"]);
  });

  it("replaces the whole set and dedupes what the client repeats", async () => {
    const id = mintSessionId();
    await putSkills(id, { skill_catalogue: false, pinned_skills: ["@acme/a", "@acme/b"] });
    const replaced = await putSkills(id, {
      skill_catalogue: true,
      pinned_skills: ["@acme/c", "@acme/c", "@acme/a"],
    });
    expect(replaced.status).toBe(204);

    const session = await getSession(id);
    expect(session.skill_catalogue).toBe(true);
    expect(session.pinned_skills).toEqual(["@acme/a", "@acme/c"]);
  });

  it("leaves updatedAt alone, so a pin toggle never reorders the sidebar", async () => {
    const id = mintSessionId();
    await putSkills(id, { skill_catalogue: true, pinned_skills: [] });
    const before = (await getSession(id)).updatedAt;
    await Bun.sleep(5);
    await putSkills(id, { skill_catalogue: false, pinned_skills: ["@acme/a"] });
    const after = await getSession(id);
    expect(after.pinned_skills).toEqual(["@acme/a"]);
    expect(after.updatedAt).toBe(before);
  });

  it("answers 404 on another tenant's session id, and writes nothing", async () => {
    const stranger = await createTestContext({ orgSlug: "chatskills-other" });
    const id = mintSessionId();
    expect((await putSkills(id, { skill_catalogue: true, pinned_skills: [] })).status).toBe(204);

    const res = await putSkills(id, { skill_catalogue: false, pinned_skills: ["@x/y"] }, stranger);
    expect(res.status).toBe(404);
    const session = await getSession(id);
    expect(session.skill_catalogue).toBe(true);
    expect(session.pinned_skills).toEqual([]);
  });

  it("refuses a non-boolean catalogue, a malformed id, an unknown field, and more pins than the ceiling", async () => {
    const id = mintSessionId();
    const atCap = Array.from({ length: MAX_PINNED_SKILLS }, (_, i) => `@acme/s${i}`);
    const overCap = [...atCap, "@acme/one-more"];
    for (const body of [
      { skill_catalogue: "yes", pinned_skills: [] },
      { skill_catalogue: true, pinned_skills: ["not-a-package-id"] },
      { skill_catalogue: true, pinned_skills: [], skill_mode: "auto" },
      { skill_catalogue: true, pinned_skills: overCap },
    ]) {
      expect((await putSkills(id, body)).status).toBe(400);
    }
    // None of the refusals created the session; the cap itself is accepted.
    expect((await app.request(`/api/chat/sessions/${id}`, json())).status).toBe(404);
    expect((await putSkills(id, { skill_catalogue: true, pinned_skills: atCap })).status).toBe(204);
  });

  it("carries the selection on the create, list and detail routes", async () => {
    const created = await app.request(
      "/api/chat/sessions",
      json({ method: "POST", body: JSON.stringify({}) }),
    );
    expect(created.status).toBe(201);
    const fresh = (await created.json()) as SessionDto;
    expect(fresh.skill_catalogue).toBe(true);
    expect(fresh.pinned_skills).toEqual([]);

    await putSkills(fresh.id, { skill_catalogue: false, pinned_skills: ["@acme/a"] });

    const list = (await (await app.request("/api/chat/sessions", json())).json()) as {
      data: SessionDto[];
    };
    const row = list.data.find((s) => s.id === fresh.id);
    expect(row?.skill_catalogue).toBe(false);
    expect(row?.pinned_skills).toEqual(["@acme/a"]);

    const detail = await getSession(fresh.id);
    expect(detail.skill_catalogue).toBe(false);
    expect(detail.pinned_skills).toEqual(["@acme/a"]);
  });
});
