// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC spec §4.4 — a space-role decision is taken on ONE snapshot of the space
 * row and the caller's explicit row, and the request carries the row it was
 * judged on (#1472).
 *
 * A race cannot be staged deterministically, so these pin the three properties
 * that close it instead: `loadSpaceAccess` returns the inputs together,
 * `applySpacePermissions` judges the row IT reads rather than the one it was
 * handed, and `updateSpace` refuses to write access columns that moved since the
 * request was authorized.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spaceMembers, spaces } from "@appstrate/db/schema";
import { prefixedId } from "@appstrate/db/ids";
import type { AppEnv } from "../../../src/types/index.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import { loadSpaceAccess, type SpaceContextRow } from "../../../src/lib/space-lookup.ts";
import { applySpacePermissions } from "../../../src/middleware/space-context.ts";
import { updateSpace } from "../../../src/services/spaces.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedSpace, seedSpaceRole } from "../../helpers/seed.ts";

type Access = Pick<SpaceContextRow, "visibility" | "defaultRole">;

async function setAccess(spaceId: string, access: Access) {
  await db.update(spaces).set(access).where(eq(spaces.id, spaceId));
}

describe("loadSpaceAccess", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  it("returns the space, the explicit preset row and the org role together", async () => {
    const member = await createTestUser();
    await addOrgMember(ctx.orgId, member.id, "member");
    const space = await seedSpace({ orgId: ctx.orgId, name: "Team" });
    await db
      .insert(spaceMembers)
      .values({ spaceId: space.id, userId: member.id, presetRole: "operator" });

    const access = await loadSpaceAccess(space.id, ctx.orgId, member.id);

    expect(access?.space.id).toBe(space.id);
    expect(access?.orgRole).toBe("member");
    expect(access?.member).toEqual({ ref: { kind: "preset", preset: "operator" } });
  });

  it("joins a custom role bundle in the same statement", async () => {
    const member = await createTestUser();
    await addOrgMember(ctx.orgId, member.id, "member");
    const space = await seedSpace({ orgId: ctx.orgId, name: "Team" });
    const role = await seedSpaceRole({ orgId: ctx.orgId, permissions: ["agents:read"] });
    await db
      .insert(spaceMembers)
      .values({ spaceId: space.id, userId: member.id, customRoleId: role.id });

    const access = await loadSpaceAccess(space.id, ctx.orgId, member.id);

    expect(access?.member?.ref).toEqual({
      kind: "custom",
      role: { id: role.id, key: role.key, name: role.name, permissions: ["agents:read"] },
    });
  });

  it("answers no row and no org role for a stranger, and never another user's row", async () => {
    const member = await createTestUser();
    await addOrgMember(ctx.orgId, member.id, "member");
    const stranger = await createTestUser();
    const space = await seedSpace({ orgId: ctx.orgId, name: "Team" });
    await db
      .insert(spaceMembers)
      .values({ spaceId: space.id, userId: member.id, presetRole: "admin" });

    const access = await loadSpaceAccess(space.id, ctx.orgId, stranger.id);

    expect(access?.space.id).toBe(space.id);
    expect(access?.member).toBeNull();
    expect(access?.orgRole).toBeNull();
  });

  it("is null for a space of another organization", async () => {
    const other = await createTestContext();
    const space = await seedSpace({ orgId: other.orgId, name: "Elsewhere" });

    expect(await loadSpaceAccess(space.id, ctx.orgId, ctx.user.id)).toBeNull();
  });
});

describe("applySpacePermissions judges the row it reads", () => {
  let ctx: TestContext;
  let memberId: string;
  let space: SpaceContextRow;

  /** A request admitted into the org as `member`, entering `space` with the row it is handed. */
  async function enter(handed: SpaceContextRow) {
    const probe = new Hono<AppEnv>();
    probe.get("/", async (c) => {
      c.set("user", { id: memberId, email: "", name: "" });
      c.set("orgId", ctx.orgId);
      c.set("orgRole", "member");
      c.set("principalKind", "user");
      c.set("authMethod", "session");
      c.set("orgPermissions", new Set());
      try {
        await applySpacePermissions(c, handed);
      } catch (err) {
        if (err instanceof ApiError) return c.json({ status: err.status }, 200);
        throw err;
      }
      return c.json({ space: c.get("space"), role: c.get("spaceRole") });
    });
    return (await (await probe.request("/")).json()) as {
      status?: number;
      space?: SpaceContextRow;
      role?: unknown;
    };
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    const member = await createTestUser();
    memberId = member.id;
    await addOrgMember(ctx.orgId, member.id, "member");
    const row = await seedSpace({ orgId: ctx.orgId, name: "Team" });
    space = { ...row, orphanedAt: null };
  });

  it("refuses when the handed row is open but the stored one is closed", async () => {
    await setAccess(space.id, { visibility: "closed", defaultRole: "admin" });

    const out = await enter({ ...space, visibility: "open", defaultRole: "admin" });

    expect(out.status).toBe(403);
  });

  it("admits on the stored row and carries it, not the handed one", async () => {
    await setAccess(space.id, { visibility: "open", defaultRole: "builder" });

    const out = await enter({ ...space, visibility: "closed", defaultRole: "viewer" });

    expect(out.role).toEqual({ kind: "preset", preset: "builder" });
    expect(out.space?.visibility).toBe("open");
    expect(out.space?.defaultRole).toBe("builder");
  });

  it("404s a space that left the organization between lookup and judgement", async () => {
    const gone = { ...space, id: prefixedId("spc") };

    expect((await enter(gone)).status).toBe(404);
  });
});

describe("updateSpace writes access columns only against the judged state", () => {
  let ctx: TestContext;
  let space: SpaceContextRow;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    const row = await seedSpace({ orgId: ctx.orgId, name: "Team" });
    await setAccess(row.id, { visibility: "closed", defaultRole: "viewer" });
    space = { ...row, visibility: "closed", defaultRole: "viewer", orphanedAt: null };
  });

  it("409s when visibility or default role moved since the request was authorized", async () => {
    // A concurrent PATCH already raised the default after this one was judged.
    await setAccess(space.id, { visibility: "closed", defaultRole: "admin" });

    const err = await updateSpace(ctx.orgId, space.id, { visibility: "open" }, space).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe("space_access_changed");
    const [stored] = await db.select().from(spaces).where(eq(spaces.id, space.id));
    expect(stored!.visibility).toBe("closed");
  });

  it("writes when the judged state still holds", async () => {
    const updated = await updateSpace(ctx.orgId, space.id, { visibility: "open" }, space);

    expect(updated.visibility).toBe("open");
  });

  it("does not condition a write that leaves the access columns alone", async () => {
    await setAccess(space.id, { visibility: "closed", defaultRole: "admin" });

    const updated = await updateSpace(ctx.orgId, space.id, { name: "Renamed" }, space);

    expect(updated.name).toBe("Renamed");
  });

  it("still 404s a space that is gone", async () => {
    const err = await updateSpace(
      ctx.orgId,
      prefixedId("spc"),
      { visibility: "open" },
      space,
    ).catch((e: unknown) => e);

    expect((err as ApiError).status).toBe(404);
  });
});
