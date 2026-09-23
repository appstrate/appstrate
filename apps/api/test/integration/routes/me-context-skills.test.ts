// SPDX-License-Identifier: Apache-2.0

// `GET /api/me/context?skills=`: exact-id resolution of the skills a chat pins.
// Fixtures pair two resolvable skills with three that must not resolve — unknown,
// another organization's, and one switched off in this space — so a read that
// drops the tenant or activation filter, or returns nothing, cannot pass.

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import { MAX_REQUESTED_SKILLS } from "../../../src/lib/skill-requests.ts";
import { MAX_PINNED_SKILLS } from "../../../../../packages/module-chat/src/skills.ts";

const app = getTestApp();

const FIRST = "@ctxskill/first";
const SECOND = "@ctxskill/second";
const UNKNOWN = "@ctxskill/nope";
const FOREIGN = "@ctxother/foreign";
const SWITCHED_OFF = "@ctxskill/off";

interface ContextBody {
  skills: { package_id: string }[];
  requested_skills: { package_id: string; version: string | null; source: string }[];
}

async function createSkill(ctx: TestContext, id: string) {
  const res = await app.request("/api/packages/skills", {
    method: "POST",
    headers: authHeaders(ctx, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      manifest: {
        name: id,
        version: "1.0.0",
        type: "skill",
        schema_version: "0.1",
        display_name: `Skill ${id}`,
        description: "A resolution fixture.",
      },
      // Frontmatter `name` is the unscoped half of the id (skill-frontmatter gate).
      content: `---\nname: "${id.split("/")[1]}"\ndescription: "A resolution fixture."\n---\n\nBody.`,
    }),
  });
  expect(res.status).toBe(201);
}

describe("GET /api/me/context?skills=", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    await createSkill(ctx, FIRST);
    await createSkill(ctx, SECOND);
  });

  it("resolves this space's active skills by exact id, and nothing else", async () => {
    await createSkill(await createTestContext(), FOREIGN);
    await createSkill(ctx, SWITCHED_OFF);
    const off = await app.request(`/api/spaces/${ctx.defaultSpaceId}/packages/${SWITCHED_OFF}`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(off.status).toBe(204);

    const query = encodeURIComponent([UNKNOWN, FIRST, FOREIGN, SWITCHED_OFF, SECOND].join(","));
    const res = await app.request(`/api/me/context?skills=${query}`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ContextBody;

    expect(body.requested_skills.map((s) => s.package_id).sort()).toEqual([FIRST, SECOND]);
    expect(body.requested_skills[0]?.version).toBe("1.0.0");
  });

  it("returns no requested skill when the parameter is absent", async () => {
    const res = await app.request("/api/me/context", { headers: authHeaders(ctx) });
    const body = (await res.json()) as ContextBody;
    expect(body.requested_skills).toEqual([]);
  });

  it("answers nothing about the requested skills without `skills:read`", async () => {
    // `agents:run` without `skills:read`: the payload builds, the skill halves are refused.
    const apiKey = await seedApiKey({
      createdBy: ctx.user.id,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      scopes: ["agents:run"],
    });
    const res = await app.request(
      `/api/me/context?skills=${encodeURIComponent([FIRST, SECOND].join(","))}`,
      { headers: { Authorization: `Bearer ${apiKey.rawKey}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ContextBody;
    expect(body.requested_skills).toEqual([]);
    expect(body.skills).toEqual([]);
  });

  it("accepts the largest request the chat can build, and refuses one id past the cap", async () => {
    const pins = [
      FIRST,
      ...Array.from({ length: MAX_PINNED_SKILLS - 1 }, (_, i) => `@ctxskill/pin-${i}`),
    ];
    const ok = await app.request(`/api/me/context?skills=${encodeURIComponent(pins.join(","))}`, {
      headers: authHeaders(ctx),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as ContextBody;
    expect(body.requested_skills.map((s) => s.package_id)).toEqual([FIRST]);

    const over = Array.from({ length: MAX_REQUESTED_SKILLS + 1 }, (_, i) => `@ctxskill/x-${i}`);
    const refused = await app.request(
      `/api/me/context?skills=${encodeURIComponent(over.join(","))}`,
      { headers: authHeaders(ctx) },
    );
    expect(refused.status).toBe(400);
  });

  it("rejects the whole parameter when an id is not @scope/name", async () => {
    const res = await app.request(
      `/api/me/context?skills=${encodeURIComponent(`${FIRST},not-a-package-id`)}`,
      { headers: authHeaders(ctx) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { param?: string };
    expect(body.param).toBe("skills");
  });
});
