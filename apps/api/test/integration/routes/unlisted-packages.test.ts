// SPDX-License-Identifier: Apache-2.0

// `unlisted` visibility: off the catalogues (index, context hints), on the library
// map, still readable by exact id. Each listing assertion carries a listed sibling
// so an empty listing cannot pass for one that excluded the right row.

import { beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { apiIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { VISIBILITY_META_NAMESPACE } from "../../../src/lib/package-helpers.ts";

const app = getTestApp();

const LISTED = "@vis/listed-skill";
const UNLISTED = "@vis/unlisted-skill";
const API_KEY_AUTH = {
  primary: {
    type: "api_key" as const,
    authorizedUris: ["https://api.vis.test/**"],
    credentialFields: ["api_key"],
    delivery: { env: { API_KEY: { value: "{$credential.api_key}", sensitive: true } } },
  },
};
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

  // The management map is the one listing an unlisted package must stay on.
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
    // The window `total` must not count the unlisted row either.
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

  // The two other listings `listedFilter` narrows. System rows are placed and
  // active in every space, so the listing itself is the only thing that differs.
  for (const [type, listPath] of [
    ["agent", "/api/agents"],
    ["integration", "/api/integrations"],
  ] as const) {
    it(`GET ${listPath} lists the sibling and not the unlisted ${type}`, async () => {
      const listed = `@appstrate/vis-listed-${type}`;
      const unlisted = `@appstrate/vis-unlisted-${type}`;
      for (const [id, meta] of [
        [listed, undefined],
        [unlisted, { [VISIBILITY_META_NAMESPACE]: { level: "unlisted" } }],
      ] as const) {
        const base =
          type === "integration"
            ? apiIntegrationManifest({ name: id, auths: API_KEY_AUTH })
            : { name: id, version: "1.0.0", type, schema_version: "0.1", display_name: id };
        await seedPackage({
          id,
          orgId: null,
          homeSpaceId: null,
          source: "system",
          type,
          draftManifest: { ...base, ...(meta ? { _meta: meta } : {}) },
        });
      }
      const res = await app.request(listPath, { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const ids = ((await res.json()) as { data: { id: string }[] }).data.map((row) => row.id);
      expect(ids).toContain(listed);
      expect(ids).not.toContain(unlisted);
    });
  }

  it("a plain member reads an unlisted SYSTEM skill by exact id, and does not see it listed", async () => {
    const SYSTEM_UNLISTED = "@appstrate/vis-hidden-system";
    const body = '---\nname: vis-hidden-system\ndescription: "Hidden."\n---\n\nSystem body.';
    await seedPackage({
      id: SYSTEM_UNLISTED,
      orgId: null,
      homeSpaceId: null,
      source: "system",
      type: "skill",
      draftManifest: skillManifest(SYSTEM_UNLISTED, {
        [VISIBILITY_META_NAMESPACE]: { level: "unlisted" },
      }),
      draftContent: body,
    });
    const member = await memberContext(ctx, "member");

    const read = await app.request(`/api/packages/skills/${SYSTEM_UNLISTED}`, {
      headers: authHeaders(member),
    });
    expect(read.status).toBe(200);
    const detail = (await read.json()) as { id: string; content: string };
    expect(detail.id).toBe(SYSTEM_UNLISTED);
    expect(detail.content).toBe(body);

    const list = await app.request("/api/packages/skills", { headers: authHeaders(member) });
    expect(list.status).toBe(200);
    const ids = ((await list.json()) as { data: { id: string }[] }).data.map((row) => row.id);
    expect(ids).toContain(LISTED);
    expect(ids).not.toContain(SYSTEM_UNLISTED);
  });
});
