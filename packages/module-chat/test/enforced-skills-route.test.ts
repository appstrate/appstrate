// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/orgs/:orgId/chat/enforced-skills?spaceId=` — the names the composer shows for the
 * skills a space imposes on the conversations started in it. Gated like the turn that injects
 * them (`chat:write`), and never the content, which a member without `skills:read` may not otherwise see.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  orgOnlyHeaders,
  memberContext,
  memberHolding,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import {
  seedPublishedVersion,
  seedSpace,
  seedSpaceMember,
  seedSpacePackage,
} from "../../../apps/api/test/helpers/seed.ts";
import { getDiscoveredModules } from "../../../apps/api/test/helpers/test-modules.ts";
import { buildModuleInitContext } from "../../../apps/api/src/lib/modules/registry.ts";
import { buildChatPlatformDeps } from "../src/platform-services.ts";
import { createChatRouter } from "../src/routes.ts";

const app = getTestApp();

const SKILL_ID = "@chatenforced/house";
const BODY_MARKER = "HOUSE-BODY-NEVER-ON-THE-WIRE";

describe("GET /api/orgs/:orgId/chat/enforced-skills", () => {
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

  const list = (
    caller: TestContext,
    spaceId: string | null = caller.defaultSpaceId,
    headers = orgOnlyHeaders(caller),
  ): Promise<Response> =>
    app.request(
      `/api/orgs/${caller.orgId}/chat/enforced-skills${spaceId === null ? "" : `?spaceId=${spaceId}`}`,
      { headers },
    );
  const ids = async (res: Response) =>
    ((await res.json()) as { data: { id: string }[] }).data.map((skill) => skill.id);

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

  it("answers a member who reads the chat, and refuses one who does not", async () => {
    await seedEnforcedSkill();
    // `viewer` holds `chat:read` alone: a read, admitted like the other reads.
    const viewer = await memberContext(ctx, "member", "viewer");
    const viewerRes = await list(viewer);
    expect(viewerRes.status).toBe(200);
    expect(await ids(viewerRes)).toEqual([SKILL_ID]);

    const outsider = await memberHolding(ctx, ["agents:read"]);
    expect((await list(outsider)).status).toBe(403);
  });

  it("answers the named space's skills alone", async () => {
    await seedEnforcedSkill();
    const other = (await seedSpace({ orgId: ctx.orgId, name: "Other" })).id;
    expect(await ids(await list(ctx, other))).toEqual([]);
    await seedSpacePackage(other, SKILL_ID, { chatEnforced: true });
    expect(await ids(await list(ctx, other))).toEqual([SKILL_ID]);
  });

  it("requires spaceId, a space the caller reads chats in (400 naming the field)", async () => {
    const missing = await list(ctx, null);
    expect(missing.status).toBe(400);
    expect(JSON.stringify(await missing.json())).toContain("spaceId");
    // A closed space the caller is not a member of is not readable.
    const closed = (await seedSpace({ orgId: ctx.orgId, name: "Closed", visibility: "closed" })).id;
    const member = await memberContext(ctx, "member", "runner");
    expect((await list(member, closed)).status).toBe(400);
    expect((await list(ctx, "spc_unknown")).status).toBe(400);
  });

  it("answers a space where the caller only reads the chat, as one where they chat", async () => {
    await seedEnforcedSkill();
    // A viewer holds `chat:read` in the default space; its chat:write comes from the runner space.
    const caller = await memberContext(ctx, "member", "viewer");
    const quiet = (await seedSpace({ orgId: ctx.orgId, name: "Quiet", visibility: "closed" })).id;
    await seedSpaceMember({ spaceId: quiet, userId: caller.user.id, presetRole: "runner" });
    await seedSpacePackage(quiet, SKILL_ID, { chatEnforced: true });
    expect(await ids(await list(caller, ctx.defaultSpaceId))).toEqual([SKILL_ID]);
    expect(await ids(await list(caller, quiet))).toEqual([SKILL_ID]);
  });

  it("ignores X-Space-Id, and refuses another organization", async () => {
    expect((await list(ctx, ctx.defaultSpaceId, authHeaders(ctx))).status).toBe(200);
    const foreign = await createTestContext({ orgSlug: "foreignenforced" });
    expect(
      (await list({ ...ctx, orgId: foreign.orgId }, ctx.defaultSpaceId, orgOnlyHeaders(ctx)))
        .status,
    ).toBe(403);
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
    const res = await failing.request(
      `/api/orgs/${ctx.orgId}/chat/enforced-skills?spaceId=${ctx.defaultSpaceId}`,
      {
        headers: authHeaders(ctx),
      },
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type") ?? "").toContain("application/problem+json");
    expect(((await res.json()) as { code?: string }).code).toBe("enforced_skills_unavailable");
  });
});
