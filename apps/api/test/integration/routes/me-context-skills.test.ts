// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/me/context?skills=` — resolving named skills by EXACT id, next to
 * the capped catalogue the same payload already carries.
 *
 * The two reads answer different questions and must not collapse into one: the
 * CATALOGUE is what the space offers to browse (visibility applies), the
 * EXACT-ID read is what a caller already decided it wants (visibility does
 * not). Every assertion below carries the contrast — a listed sibling, an
 * unlisted one, and an id nothing answers — so a read that simply returned
 * everything, or nothing, cannot pass for one that resolved the right rows.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import { VISIBILITY_META_NAMESPACE } from "../../../src/lib/package-helpers.ts";
import {
  MAX_PINNED_SKILLS,
  PLATFORM_DEFAULT_SKILLS,
} from "../../../../../packages/module-chat/src/skills.ts";

const app = getTestApp();

const LISTED = "@ctxskill/listed";
const UNLISTED = "@ctxskill/unlisted";
const UNKNOWN = "@ctxskill/nope";

interface ContextBody {
  space: { id: string; name: string | null };
  skills: { package_id: string }[];
  requested_skills: { package_id: string; version: string | null; source: string }[];
  unresolved_skills: string[];
}

async function createSkill(ctx: TestContext, id: string, unlisted: boolean) {
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
        ...(unlisted ? { _meta: { [VISIBILITY_META_NAMESPACE]: { level: "unlisted" } } } : {}),
      },
      // Frontmatter `name` is the UNSCOPED half of the id (the skill-frontmatter
      // gate), and both values are quoted YAML strings.
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
    await createSkill(ctx, LISTED, false);
    await createSkill(ctx, UNLISTED, true);
  });

  it("resolves both the listed and the unlisted skill by exact id, and reports the unknown one", async () => {
    const query = encodeURIComponent([UNKNOWN, LISTED, UNLISTED].join(","));
    const res = await app.request(`/api/me/context?skills=${query}`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ContextBody;

    // Exact-id resolution ignores visibility — that is the whole point of the
    // marker: a package hidden from the catalogue stays usable by name.
    expect(body.requested_skills.map((s) => s.package_id)).toEqual([LISTED, UNLISTED]);
    expect(body.requested_skills[0]?.version).toBe("1.0.0");
    expect(body.unresolved_skills).toEqual([UNKNOWN]);

    // …and the CATALOGUE half is unchanged: still no unlisted row on it.
    const catalogue = body.skills.map((s) => s.package_id);
    expect(catalogue).toContain(LISTED);
    expect(catalogue).not.toContain(UNLISTED);
  });

  it("sorts resolved skills by package id whatever order they were asked in", async () => {
    const res = await app.request(
      `/api/me/context?skills=${encodeURIComponent([UNLISTED, LISTED].join(","))}`,
      { headers: authHeaders(ctx) },
    );
    const body = (await res.json()) as ContextBody;
    // The chat renders this list into a single prompt-cache block: request
    // order must not reach the rendering.
    expect(body.requested_skills.map((s) => s.package_id)).toEqual([LISTED, UNLISTED]);
  });

  it("returns both fields empty when the parameter is absent", async () => {
    const res = await app.request("/api/me/context", { headers: authHeaders(ctx) });
    const body = (await res.json()) as ContextBody;
    expect(body.requested_skills).toEqual([]);
    expect(body.unresolved_skills).toEqual([]);
  });

  it("names the space the context was resolved in", async () => {
    // An operation taking a `spaceId` path param (the activation door) is
    // unreachable for a model whose context never states which space it is in.
    const res = await app.request("/api/me/context", { headers: authHeaders(ctx) });
    const body = (await res.json()) as ContextBody;
    expect(body.space.id).toBe(ctx.defaultSpaceId);
    expect(typeof body.space.name).toBe("string");
  });

  it("resolves nothing and reports every id unresolved without `skills:read`", async () => {
    // A credential whose ceiling stops short of `skills:read`. It still holds
    // `agents:run`, so the payload itself is built — only the skill halves are
    // refused, and the refusal is legible rather than an empty list.
    const apiKey = await seedApiKey({
      createdBy: ctx.user.id,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      scopes: ["agents:run"],
    });
    const res = await app.request(
      `/api/me/context?skills=${encodeURIComponent([LISTED, UNLISTED].join(","))}`,
      { headers: { Authorization: `Bearer ${apiKey.rawKey}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ContextBody;
    expect(body.requested_skills).toEqual([]);
    expect(body.unresolved_skills).toEqual([LISTED, UNLISTED]);
    expect(body.skills).toEqual([]);
  });

  it("accepts the largest request the chat can build: every default plus a full pin set", async () => {
    // The chat asks for `defaults ∪ pins` in one parameter; a cap below that
    // sum would 400 a legitimate turn, which `buildCallerContextBlock` then
    // degrades to an identity-only prompt. The ids need not resolve.
    const ids = [
      ...PLATFORM_DEFAULT_SKILLS,
      ...Array.from({ length: MAX_PINNED_SKILLS }, (_, i) => `@ctxskill/pin-${i}`),
    ];
    const res = await app.request(`/api/me/context?skills=${encodeURIComponent(ids.join(","))}`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ContextBody;
    expect(body.unresolved_skills).toHaveLength(ids.length);
  });

  it("rejects the whole parameter when an id is not @scope/name", async () => {
    const res = await app.request(
      `/api/me/context?skills=${encodeURIComponent(`${LISTED},not-a-package-id`)}`,
      { headers: authHeaders(ctx) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { param?: string };
    expect(body.param).toBe("skills");
  });
});
