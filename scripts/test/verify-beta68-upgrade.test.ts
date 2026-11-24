// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { notifications } from "@appstrate/db/schema";
import { createTestContext } from "../../apps/api/test/helpers/auth.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { seedAgent, seedRun } from "../../apps/api/test/helpers/seed.ts";
import { recordRunFinished } from "../../apps/api/src/services/state/run-reads.ts";
import { checkBeforeTraffic } from "../migration/verify-beta68-upgrade.ts";

it("detects an unnamed beta.68 failure even after its recipient read state was copied", async () => {
  await truncateAll();
  const { orgId, defaultSpaceId: spaceId, user } = await createTestContext();
  const packageId = "@preflight/agent";
  await seedAgent({ id: packageId, orgId, createdBy: user.id });
  const run = await seedRun({
    packageId,
    orgId,
    spaceId,
    userId: user.id,
    status: "failed",
    agentName: "Nightly report",
  });
  await recordRunFinished({ orgId, spaceId }, run.id);
  // Reproduce the payload written before 0052 while retaining the recipient's read marker.
  await db
    .update(notifications)
    .set({ payload: sql`payload - 'agent_name'` })
    .where(eq(notifications.runId, run.id));
  const before = new Date("2026-01-01T00:00:00Z");
  const getChecks = async () =>
    (await checkBeforeTraffic(before)).filter(({ check }) => check.startsWith("0052"));
  expect((await getChecks()).filter(({ pending }) => pending)).toEqual([
    { check: "0052 · notifications missing the recorded agent name", pending: 1 },
  ]);
  // The script owns the exact backfill, including a conflict with an existing read marker.
  const migration = await Bun.file(
    new URL("../migration/0052-run-reads.sql", import.meta.url),
  ).text();
  await db.transaction(async (tx) => {
    for (const statement of migration.replace(/^--.*$/gm, "").split(";")) {
      const sqlText = statement.trim();
      if (sqlText && sqlText !== "BEGIN" && sqlText !== "COMMIT")
        await tx.execute(sql.raw(sqlText));
    }
  });
  expect((await getChecks()).every(({ pending }) => pending === 0)).toBe(true);
});
