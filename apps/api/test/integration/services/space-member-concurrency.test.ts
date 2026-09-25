// SPDX-License-Identifier: Apache-2.0

import { beforeEach, expect, it } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db, toRows } from "@appstrate/db/client";
import { organizationMembers, spaceMembers } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import { describeRequiresPostgres } from "../../helpers/tier.ts";
import {
  deleteSpaceMembershipsInOrg,
  removeSpaceMember,
  saveSpaceMember,
} from "../../../src/services/space-members.ts";
import { applySpaceAssignments } from "../../../src/services/space-assignments.ts";
import { presetPermissions } from "../../../src/lib/permissions.ts";
import { seedSpace, seedSpaceMember } from "../../helpers/seed.ts";

// Separate PostgreSQL connections are required: PGlite serializes transactions.
describeRequiresPostgres("space grants serialize with org membership changes", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  for (const path of ["direct", "invitation"] as const) {
    for (const change of ["promote", "remove"] as const) {
      it(`does not recreate a grant after concurrent ${change} through ${path}`, async () => {
        const member = await createTestUser();
        await addOrgMember(ctx.orgId, member.id, "guest");
        const filter = and(
          eq(organizationMembers.orgId, ctx.orgId),
          eq(organizationMembers.userId, member.id),
        );
        const locked = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        // Hold the uncommitted membership change after its cleanup. Other
        // connections still see the old guest row until this transaction commits.
        const mutation = db.transaction(async (tx) => {
          if (change === "promote")
            await tx.update(organizationMembers).set({ role: "admin" }).where(filter);
          else await tx.delete(organizationMembers).where(filter);
          await deleteSpaceMembershipsInOrg(tx, ctx.orgId, member.id);
          locked.resolve();
          await release.promise;
        });
        await locked.promise;
        let settled = false;
        const pending =
          path === "direct"
            ? saveSpaceMember({
                orgId: ctx.orgId,
                spaceId: ctx.defaultSpaceId,
                userId: member.id,
                assignment: { preset_role: "builder" },
                actorPermissions: presetPermissions("admin"),
                addedBy: ctx.user.id,
              })
            : db.transaction((tx) =>
                applySpaceAssignments(tx, {
                  orgId: ctx.orgId,
                  userId: member.id,
                  addedBy: ctx.user.id,
                  assignments: [{ spaceId: ctx.defaultSpaceId, preset_role: "builder" }],
                  onMissing: "skip",
                }),
              );
        const grant = pending.then(
          () => {
            settled = true;
            return null;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
        try {
          // Wait for either the old implementation to finish or the corrected
          // one to reach the conflicting row lock. No assumed scheduling delay.
          let waiting = false;
          const deadline = Date.now() + 5000;
          while (!settled && !waiting && Date.now() < deadline) {
            const rows = toRows<{ waiting: boolean }>(
              await db.execute(sql`
            SELECT EXISTS (SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock' AND query LIKE '%org_members%') AS waiting
          `),
            );
            waiting = rows[0]!.waiting;
            if (!settled && !waiting) await Bun.sleep(10);
          }
          expect(settled || waiting).toBe(true);
        } finally {
          release.resolve();
          await mutation;
        }
        const error = await grant;
        if (path === "invitation" && change === "promote") expect(error).toBeNull();
        else expect(error).toMatchObject({ status: change === "promote" ? 409 : 404 });
        expect(
          await db.select().from(spaceMembers).where(eq(spaceMembers.userId, member.id)),
        ).toHaveLength(0);
      });
    }
  }
});

// The removal's OTHER bound (#1439). `assertCanManageSpaceMember` — covered by
// `space-role-delegation.test.ts` — asks whether the caller could have granted
// the row being dropped. This one asks what dropping it LEAVES BEHIND: in an
// `open` space the explicit row is a restriction, and deleting it hands the
// target the implicit standing their ORG role resolves to. Read outside the
// lock, that standing was whatever `org_members` said before a concurrent
// promotion moved it.
describeRequiresPostgres("the removal's grant bound is judged under the lock", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  // `operator` default, so an org `member` target is left with `operator` —
  // exactly what the actor holds — while an org `admin` target is left with
  // preset `admin`, which it does not.
  const openSpace = () =>
    seedSpace({ orgId: ctx.orgId, visibility: "open", defaultRole: "operator" });
  const actorPermissions = new Set([...presetPermissions("operator"), "space-members:remove"]);

  it("permits the removal when the target's org role stands still", async () => {
    const space = await openSpace();
    const target = await createTestUser();
    await addOrgMember(ctx.orgId, target.id, "member");
    // The row RESTRICTS: `viewer` in a space whose default is `operator`.
    await seedSpaceMember({ spaceId: space.id, userId: target.id, presetRole: "viewer" });

    expect(
      await removeSpaceMember({ orgId: ctx.orgId, space, userId: target.id, actorPermissions }),
    ).toEqual({ removed: true, accessAfter: { kind: "preset", preset: "operator" } });
  });

  it("refuses it against a promotion that commits between the read and the DELETE", async () => {
    const space = await openSpace();
    const target = await createTestUser();
    await addOrgMember(ctx.orgId, target.id, "member");
    await seedSpaceMember({ spaceId: space.id, userId: target.id, presetRole: "viewer" });
    const filter = and(
      eq(organizationMembers.orgId, ctx.orgId),
      eq(organizationMembers.userId, target.id),
    );

    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Uncommitted: other connections still read `member` until this commits.
    const promotion = db.transaction(async (tx) => {
      await tx.update(organizationMembers).set({ role: "admin" }).where(filter);
      await deleteSpaceMembershipsInOrg(tx, ctx.orgId, target.id);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    let settled = false;
    const pending = removeSpaceMember({
      orgId: ctx.orgId,
      space,
      userId: target.id,
      actorPermissions,
    });
    const removal = pending.then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      // Either the stale implementation answered off the uncommitted-away role,
      // or the corrected one is parked on the row lock. No assumed delay.
      let waiting = false;
      const deadline = Date.now() + 5000;
      while (!settled && !waiting && Date.now() < deadline) {
        const rows = toRows<{ waiting: boolean }>(
          await db.execute(sql`
            SELECT EXISTS (SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock' AND query LIKE '%org_members%') AS waiting
          `),
        );
        waiting = rows[0]!.waiting;
        if (!settled && !waiting) await Bun.sleep(10);
      }
      expect(settled || waiting).toBe(true);
    } finally {
      release.resolve();
      await promotion;
    }

    // 403 on the standing the COMMITTED role leaves behind — preset `admin`.
    // The grant bound refuses before the manage bound is ever reached, since
    // the promotion swept the row. Before #1439 the role was read outside the
    // lock: it said `member`, the bound cleared on the `operator` default, and
    // the swept row came back as merely missing (404). Deleting the assertion
    // reproduces exactly that, which is how this test was shown to discriminate.
    await expect(removal).resolves.toMatchObject({ status: 403 });
  });
});
