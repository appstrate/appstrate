// SPDX-License-Identifier: Apache-2.0

/**
 * `unlisted` visibility — the AFPS §10.1 vendor extension
 * `_meta["dev.appstrate/visibility"].level = "unlisted"`.
 *
 * Discoverability, never authorization: the package is off every CATALOGUE
 * surface — the per-type index, the caller-context hints the chat renders — and
 * still readable by exact id. The library map is deliberately NOT one of them:
 * it is the placement/management view its owner acts on. Each assertion carries
 * a LISTED sibling created the same way, so a listing that simply came back
 * empty cannot pass for a listing that excluded the right row.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { VISIBILITY_META_NAMESPACE } from "../../../src/lib/package-helpers.ts";

const app = getTestApp();

const LISTED = "@vis/listed-skill";
const UNLISTED = "@vis/unlisted-skill";
const UNLISTED_BODY = "---\nname: unlisted-skill\ndescription: Hidden skill.\n---\n\nSecret body.";

function skillManifest(id: string, meta?: Record<string, unknown>) {
  return {
    name: id,
    version: "1.0.0",
    type: "skill",
    schema_version: "0.1",
    display_name: `Skill ${id}`,
    description: "A visibility fixture.",
    ...(meta ? { _meta: meta } : {}),
  };
}

async function createSkill(ctx: TestContext, id: string, content: string, unlisted: boolean) {
  const meta = unlisted ? { [VISIBILITY_META_NAMESPACE]: { level: "unlisted" } } : undefined;
  const res = await app.request("/api/packages/skills", {
    method: "POST",
    headers: authHeaders(ctx, { "Content-Type": "application/json" }),
    body: JSON.stringify({ manifest: skillManifest(id, meta), content }),
  });
  expect(res.status).toBe(201);
}

describe("unlisted package visibility", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    await createSkill(
      ctx,
      LISTED,
      "---\nname: listed-skill\ndescription: Visible skill.\n---\n\nBody.",
      false,
    );
    await createSkill(ctx, UNLISTED, UNLISTED_BODY, true);
  });

  it("GET /api/packages/skills lists the sibling and not the unlisted skill", async () => {
    const res = await app.request("/api/packages/skills", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    const ids = body.data.map((row) => row.id);
    expect(ids).toContain(LISTED);
    expect(ids).not.toContain(UNLISTED);
  });

  /**
   * The library is the MANAGEMENT map (placement state, owner/admin only), not
   * a catalogue — so it is the one listing an unlisted package stays on. If it
   * hid one too, an org's own unlisted package would appear on NO listing at
   * all, leaving nothing to place, activate or delete it from.
   */
  it("GET /api/library maps the unlisted skill alongside its sibling", async () => {
    const res = await app.request("/api/library", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { packages: { skill: { id: string }[] } };
    const ids = body.packages.skill.map((row) => row.id);
    expect(ids).toContain(LISTED);
    expect(ids).toContain(UNLISTED);
  });

  it("GET /api/me/context hints the sibling, and does not count the unlisted skill", async () => {
    const res = await app.request("/api/me/context", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skills: { package_id: string }[];
      skills_total: number;
    };
    const ids = body.skills.map((row) => row.package_id);
    expect(ids).toContain(LISTED);
    expect(ids).not.toContain(UNLISTED);
    // `total` is a window count over the same filtered set, evaluated before
    // the cap: an unlisted skill leaking into it would say the cap dropped one.
    expect(body.skills_total).toBe(body.skills.length);
  });

  it("GET /api/packages/skills/{scope}/{name} reads the unlisted skill by exact id", async () => {
    const res = await app.request(`/api/packages/skills/${UNLISTED}`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; content: string };
    expect(body.id).toBe(UNLISTED);
    expect(body.content).toBe(UNLISTED_BODY);
  });
});
