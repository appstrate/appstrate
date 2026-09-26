// SPDX-License-Identifier: Apache-2.0

/**
 * `PATCH /api/spaces/{spaceId}/packages/{scope}/{name}` with `chat_enforced`
 * (issue #1586): a space imposes a skill on every chat conversation held in it.
 *
 * Pinned here: the gate (`skills:write` in the space), the refusals in their
 * order (404 unplaced, 400 non-skill, 409 draft-only / cap / budget), that a
 * refusal writes nothing, that two concurrent enforcements cannot both pass the
 * cap, and that the audit trail records an actual change and nothing else.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditEvents, packages, spacePackages } from "@appstrate/db/schema";
import {
  CHAT_SKILLS_CONTENT_BUDGET_CHARS,
  MAX_ENFORCED_CHAT_SKILLS,
} from "@appstrate/core/chat-contract";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { expectProblem } from "../../helpers/assertions.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedPackage,
  seedPublishedVersion,
  seedSpaceMember,
  seedSpacePackage,
  seedSpaceRole,
} from "../../helpers/seed.ts";

const app = getTestApp();

let ctx: TestContext;

const patch = (packageId: string, body: Record<string, unknown>, as: TestContext = ctx) =>
  app.request(`/api/spaces/${ctx.defaultSpaceId}/packages/${packageId}`, {
    method: "PATCH",
    headers: authHeaders(as, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });

/** A skill homed in the default space, placed and active there; published unless told not to. */
async function seedSkill(
  id: string,
  opts: { publish?: boolean; content?: string; enforced?: boolean } = {},
): Promise<void> {
  await seedPackage({
    id,
    orgId: ctx.orgId,
    type: "skill",
    homeSpaceId: ctx.defaultSpaceId,
    draftManifest: { name: id, version: "1.0.0", type: "skill", display_name: id },
    draftContent: opts.content ?? `---\nname: skill\ndescription: A skill.\n---\n${id}`,
  });
  await seedSpacePackage(ctx.defaultSpaceId, id, { chatEnforced: opts.enforced ?? false });
  if (opts.publish ?? true) await seedPublishedVersion(id, "1.0.0");
}

const storedFlag = async (packageId: string) => {
  const [row] = await db
    .select({ chatEnforced: spacePackages.chatEnforced })
    .from(spacePackages)
    .where(
      and(eq(spacePackages.spaceId, ctx.defaultSpaceId), eq(spacePackages.packageId, packageId)),
    );
  return row?.chatEnforced ?? null;
};

const audits = (action: string, packageId: string) =>
  db
    .select({ after: auditEvents.after })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.resourceId, packageId)));

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "enforce" });
});

describe("enforcing a skill in the chat", () => {
  it("writes the flag, echoes it, and the library carries it", async () => {
    await seedSkill("@enforce/tone");

    const res = await patch("@enforce/tone", { chat_enforced: true });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({
      object: "space_package",
      packageId: "@enforce/tone",
      chat_enforced: true,
    });
    expect(await storedFlag("@enforce/tone")).toBe(true);

    const detail = await app.request(`/api/spaces/${ctx.defaultSpaceId}/packages/@enforce/tone`, {
      headers: authHeaders(ctx),
    });
    expect(((await detail.json()) as { chat_enforced: boolean }).chat_enforced).toBe(true);

    const library = await app.request(`/api/spaces/${ctx.defaultSpaceId}/library`, {
      headers: authHeaders(ctx),
    });
    const body = (await library.json()) as {
      packages: Record<string, { id: string; placements: { chat_enforced: boolean }[] }[]>;
    };
    const row = body.packages.skill?.find((entry) => entry.id === "@enforce/tone");
    expect(row?.placements.map((p) => p.chat_enforced)).toEqual([true]);
  });

  it("keeps the other fields of the same patch working", async () => {
    await seedSkill("@enforce/tone");
    const res = await patch("@enforce/tone", { chat_enforced: true, proxyId: null });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ chat_enforced: true, proxyId: null });
  });

  it("is refused without `skills:write` in the space", async () => {
    await seedSkill("@enforce/tone");
    const readOnly = await seedSpaceRole({
      orgId: ctx.orgId,
      key: "skills-reader",
      permissions: ["skills:read"],
    });
    const reader = await memberContext(ctx, "member");
    await seedSpaceMember({
      spaceId: ctx.defaultSpaceId,
      userId: reader.user.id,
      presetRole: null,
      customRoleId: readOnly.id,
    });

    await expectProblem(await patch("@enforce/tone", { chat_enforced: true }, reader), 403);
    expect(await storedFlag("@enforce/tone")).toBe(false);

    // Control: a member whose role adds `skills:write`, and nothing else.
    const writerRole = await seedSpaceRole({
      orgId: ctx.orgId,
      key: "skills-writer",
      permissions: ["skills:read", "skills:write"],
    });
    const writer = await memberContext(ctx, "member");
    await seedSpaceMember({
      spaceId: ctx.defaultSpaceId,
      userId: writer.user.id,
      presetRole: null,
      customRoleId: writerRole.id,
    });
    const ok = await patch("@enforce/tone", { chat_enforced: true }, writer);
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  it("404s a skill that is not placed here, before any 409", async () => {
    // Not published either: the placement refusal is the one answered.
    await seedPackage({
      id: "@enforce/elsewhere",
      orgId: ctx.orgId,
      type: "skill",
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: { name: "@enforce/elsewhere", version: "1.0.0", type: "skill" },
    });
    await expectProblem(await patch("@enforce/elsewhere", { chat_enforced: true }), 404);
    expect(await storedFlag("@enforce/elsewhere")).toBeNull();
  });

  it("400s a package that is not a skill", async () => {
    await seedPackage({ id: "@enforce/agent", orgId: ctx.orgId, homeSpaceId: ctx.defaultSpaceId });
    await seedSpacePackage(ctx.defaultSpaceId, "@enforce/agent");
    for (const value of [true, false]) {
      await expectProblem(await patch("@enforce/agent", { chat_enforced: value }), 400, {
        code: "chat_enforced_not_skill",
      });
    }
    expect(await storedFlag("@enforce/agent")).toBe(false);
  });

  it("409s a draft-only skill and writes nothing of the patch", async () => {
    await seedSkill("@enforce/draft", { publish: false });
    await expectProblem(
      await patch("@enforce/draft", { chat_enforced: true, proxyId: "prx_never" }),
      409,
      { code: "no_published_version" },
    );
    const [row] = await db
      .select({ chatEnforced: spacePackages.chatEnforced, proxyId: spacePackages.proxyId })
      .from(spacePackages)
      .where(eq(spacePackages.packageId, "@enforce/draft"));
    expect(row).toEqual({ chatEnforced: false, proxyId: null });
  });

  it("409s past the cap — every flagged row counts, a deactivated one included", async () => {
    for (let i = 0; i < MAX_ENFORCED_CHAT_SKILLS; i++) {
      await seedSkill(`@enforce/on-${i}`, { enforced: true });
    }
    // Switched off, still flagged: re-activating it would bring it back.
    await seedSpacePackage(ctx.defaultSpaceId, "@enforce/on-0", { enabled: false });
    await seedSkill("@enforce/one-more");

    await expectProblem(await patch("@enforce/one-more", { chat_enforced: true }), 409, {
      code: "enforced_skills_limit",
    });
    expect(await storedFlag("@enforce/one-more")).toBe(false);

    // Releasing one frees the slot.
    expect((await patch("@enforce/on-1", { chat_enforced: false })).status).toBe(200);
    expect((await patch("@enforce/one-more", { chat_enforced: true })).status).toBe(200);
  });

  it("409s when the published SKILL.md bodies would exceed the budget", async () => {
    const half = Math.floor(CHAT_SKILLS_CONTENT_BUDGET_CHARS / 2);
    await seedSkill("@enforce/big", { content: "a".repeat(half + 1), enforced: true });
    await seedSkill("@enforce/also-big", { content: "b".repeat(half) });

    await expectProblem(await patch("@enforce/also-big", { chat_enforced: true }), 409, {
      code: "enforced_skills_budget",
    });
    expect(await storedFlag("@enforce/also-big")).toBe(false);

    // What counts is the PUBLISHED body: a small draft does not make it fit…
    await db
      .update(packages)
      .set({ draftContent: "tiny" })
      .where(eq(packages.id, "@enforce/also-big"));
    await expectProblem(await patch("@enforce/also-big", { chat_enforced: true }), 409, {
      code: "enforced_skills_budget",
    });
    // …a smaller published version does.
    await seedPublishedVersion("@enforce/also-big", "1.0.1", {
      manifest: { name: "@enforce/also-big", version: "1.0.1", type: "skill" },
      content: "b".repeat(half - 1),
    });
    expect((await patch("@enforce/also-big", { chat_enforced: true })).status).toBe(200);
  });

  it("lets exactly one of two concurrent enforcements at cap − 1 through", async () => {
    for (let i = 0; i < MAX_ENFORCED_CHAT_SKILLS - 1; i++) {
      await seedSkill(`@enforce/on-${i}`, { enforced: true });
    }
    await seedSkill("@enforce/left");
    await seedSkill("@enforce/right");

    const statuses = (
      await Promise.all([
        patch("@enforce/left", { chat_enforced: true }),
        patch("@enforce/right", { chat_enforced: true }),
      ])
    )
      .map((res) => res.status)
      .sort();
    expect(statuses).toEqual([200, 409]);
    const flagged = await db
      .select({ packageId: spacePackages.packageId })
      .from(spacePackages)
      .where(
        and(eq(spacePackages.spaceId, ctx.defaultSpaceId), eq(spacePackages.chatEnforced, true)),
      );
    expect(flagged).toHaveLength(MAX_ENFORCED_CHAT_SKILLS);
  });
});

describe("the audit trail", () => {
  it("records an enforcement and a release once each, and never a repeat", async () => {
    await seedSkill("@enforce/tone");

    expect((await patch("@enforce/tone", { chat_enforced: true })).status).toBe(200);
    expect((await patch("@enforce/tone", { chat_enforced: true })).status).toBe(200);
    expect(await audits("package.chat_enforced", "@enforce/tone")).toEqual([
      { after: { spaceId: ctx.defaultSpaceId } },
    ]);

    expect((await patch("@enforce/tone", { chat_enforced: false })).status).toBe(200);
    expect((await patch("@enforce/tone", { chat_enforced: false })).status).toBe(200);
    expect(await audits("package.chat_released", "@enforce/tone")).toEqual([
      { after: { spaceId: ctx.defaultSpaceId } },
    ]);
  });

  it("records nothing for releasing a skill that was never enforced, nor for other fields", async () => {
    await seedSkill("@enforce/quiet");
    expect((await patch("@enforce/quiet", { chat_enforced: false })).status).toBe(200);
    expect((await patch("@enforce/quiet", { proxyId: null })).status).toBe(200);
    expect(await audits("package.chat_released", "@enforce/quiet")).toHaveLength(0);
    expect(await audits("package.chat_enforced", "@enforce/quiet")).toHaveLength(0);
  });

  it("records nothing for a refused enforcement", async () => {
    await seedSkill("@enforce/draft", { publish: false });
    expect((await patch("@enforce/draft", { chat_enforced: true })).status).toBe(409);
    expect(await audits("package.chat_enforced", "@enforce/draft")).toHaveLength(0);
  });
});
