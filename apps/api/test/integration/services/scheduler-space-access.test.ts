// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, schedules, spaceMembers, spaces } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage, seedSpace } from "../../helpers/seed.ts";
import { createSchedule, triggerScheduledRun } from "../../../src/services/scheduler.ts";
import { removeSpaceMember } from "../../../src/services/space-members.ts";

describe("scheduled runs respect current space access", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  for (const change of ["remove", "downgrade", "close", "keep"] as const) {
    it(`${change}: revalidates the actor before resolving the scheduled agent`, async () => {
      const member = await createTestUser();
      await addOrgMember(ctx.orgId, member.id, change === "close" ? "member" : "guest");
      const space = await seedSpace({ orgId: ctx.orgId, name: "Scheduled space" });
      await db
        .update(spaces)
        .set({ visibility: change === "close" ? "open" : "private", defaultRole: "builder" })
        .where(eq(spaces.id, space.id));
      if (change !== "close") {
        await db
          .insert(spaceMembers)
          .values({ spaceId: space.id, userId: member.id, presetRole: "builder" });
      }
      const pkg = await seedPackage({ orgId: ctx.orgId, id: `@${ctx.org.slug}/scheduled-access` });
      const actor = { type: "user", id: member.id } as const;
      const schedule = await createSchedule(
        { orgId: ctx.orgId, spaceId: space.id },
        pkg.id,
        actor,
        { cronExpression: "0 * * * *" },
      );
      if (change === "remove") await removeSpaceMember(space.id, member.id);
      if (change === "downgrade")
        await db
          .update(spaceMembers)
          .set({ presetRole: "viewer" })
          .where(eq(spaceMembers.spaceId, space.id));
      if (change === "close")
        await db.update(spaces).set({ visibility: "closed" }).where(eq(spaces.id, space.id));

      await triggerScheduledRun(schedule.id, pkg.id, actor, ctx.orgId, space.id, undefined, {});
      const [row] = await db.select().from(schedules).where(eq(schedules.id, schedule.id));
      const fired = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
      expect(row!.enabled).toBe(change === "keep");
      expect(fired).toHaveLength(1);
      expect(fired[0]!.status).toBe("failed");
      if (change === "keep") {
        // The never-published fixture fails later: authorization did not disable it.
        expect(fired[0]!.error).not.toContain("Schedule disabled");
      } else {
        expect(fired[0]!.error).toContain("Schedule disabled");
      }
    });
  }
});
