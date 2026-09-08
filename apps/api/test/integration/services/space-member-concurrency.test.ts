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
  saveSpaceMember,
} from "../../../src/services/space-members.ts";
import { applySpaceAssignments } from "../../../src/services/space-assignments.ts";
import { presetPermissions } from "../../../src/lib/permissions.ts";

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
                  assignments: [{ space_id: ctx.defaultSpaceId, preset_role: "builder" }],
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
