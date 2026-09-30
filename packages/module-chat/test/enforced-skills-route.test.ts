// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/chat/enforced-skills` — the names the composer shows for the skills
 * the space imposes. Gated like the turn that injects them (`chat:write`), and
 * never the content, which a member without `skills:read` may not otherwise see.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  memberContext,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { seedPublishedVersion, seedSpacePackage } from "../../../apps/api/test/helpers/seed.ts";
import { getDiscoveredModules } from "../../../apps/api/test/helpers/test-modules.ts";
import { buildModuleInitContext } from "../../../apps/api/src/lib/modules/registry.ts";
import { buildChatPlatformDeps } from "../src/platform-services.ts";
import { createChatRouter } from "../src/routes.ts";

const app = getTestApp();

const SKILL_ID = "@chatenforced/house";
const BODY_MARKER = "HOUSE-BODY-NEVER-ON-THE-WIRE";

describe("GET /api/chat/enforced-skills", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chatenforced" });
  });

  /** A skill homed in the default space, published, and enforced there. */
  async function seedEnforcedSkill(): Promise<void> {
    const created = await app.request("/api/packages/skills", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: {
          name: SKILL_ID,
          version: "1.2.0",
          type: "skill",
          schema_version: "0.1",
          display_name: "House rules",
          description: "The house rules.",
        },
        content: '---\nname: house\ndescription: "The house rules."\n---\n\nDraft body.',
      }),
    });
    expect(created.status).toBe(201);
    await seedPublishedVersion(SKILL_ID, "1.3.0", {
      content: `---\nname: house\ndescription: "The house rules."\n---\n\n${BODY_MARKER}`,
    });
    await seedSpacePackage(ctx.defaultSpaceId, SKILL_ID, { chatEnforced: true });
  }

  function list(caller: TestContext): Promise<Response> {
    return app.request("/api/chat/enforced-skills", { headers: authHeaders(caller) });
  }

  it("answers an empty list when the space enforces nothing", async () => {
    const res = await list(ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ object: "list", data: [] });
  });

  it("answers the names and versions only, never the content", async () => {
    await seedEnforcedSkill();
    const res = await list(ctx);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(BODY_MARKER);
    const body = JSON.parse(text) as { object: string; data: Record<string, unknown>[] };
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(1);
    expect(Object.keys(body.data[0]!).sort()).toEqual(["id", "name", "version"]);
    expect(body.data[0]).toMatchObject({ id: SKILL_ID, version: "1.3.0" });
    expect(typeof body.data[0]!.name).toBe("string");
  });

  it("answers a member who writes the chat, and refuses one who only reads it", async () => {
    await seedEnforcedSkill();
    // `runner` holds `chat:write`; `viewer` holds `chat:read` alone.
    const runner = await memberContext(ctx, "member", "runner");
    const runnerRes = await list(runner);
    expect(runnerRes.status).toBe(200);
    expect(((await runnerRes.json()) as { data: { id: string }[] }).data.map((s) => s.id)).toEqual([
      SKILL_ID,
    ]);

    const viewer = await memberContext(ctx, "member", "viewer");
    expect((await list(viewer)).status).toBe(403);
  });

  it("answers a 503 `enforced_skills_unavailable` when the names cannot be read", async () => {
    // A fresh app whose chat router runs over a failing platform read.
    const initCtx = buildModuleInitContext();
    const deps = buildChatPlatformDeps({
      ...initCtx,
      services: {
        ...initCtx.services,
        listEnforcedChatSkills: async () => {
          throw new Error("database down");
        },
      },
    });
    const failing = getTestApp({
      modules: getDiscoveredModules().map((mod) =>
        mod.manifest.id === "chat" ? { ...mod, createRouter: () => createChatRouter(deps) } : mod,
      ),
    });
    const res = await failing.request("/api/chat/enforced-skills", { headers: authHeaders(ctx) });
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type") ?? "").toContain("application/problem+json");
    expect(((await res.json()) as { code?: string }).code).toBe("enforced_skills_unavailable");
  });
});
