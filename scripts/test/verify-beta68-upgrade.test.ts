// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatMessages, chatSessions, notifications } from "@appstrate/db/schema";
import { createTestContext } from "../../apps/api/test/helpers/auth.ts";
import { journalPGlite } from "../../apps/api/test/helpers/journal.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { seedAgent, seedRun } from "../../apps/api/test/helpers/seed.ts";
import { recordRunFinished } from "../../apps/api/src/services/state/run-reads.ts";
import { checkBeforeSchema, checkBeforeTraffic } from "../migration/verify-beta68-upgrade.ts";

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

it("stops an upgrade on a mis-scoped notification before 0103 renames it and 0052 copies it", async () => {
  const pg = await journalPGlite({ through: "0096_connection_calls_and_model_invariants" });
  const org = "e0000000-0000-4000-8000-000000000001";
  const otherOrg = "e0000000-0000-4000-8000-000000000002";
  const pending = async () =>
    (await checkBeforeSchema((statement) => pg.query(statement))).filter(({ pending }) => pending);
  const repair = await Bun.file(
    new URL("../migration/0057-repair-run-notification-spaces.sql", import.meta.url),
  ).text();
  try {
    await pg.exec(`
      INSERT INTO organizations (id,name,slug) VALUES ('${org}','Alpha','alpha'), ('${otherOrg}','Beta','beta');
      INSERT INTO spaces (id,org_id,name) VALUES ('spaceA','${org}','A'), ('spaceB','${otherOrg}','B');
      INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
        VALUES ('alice','Alice','alice@example.com',true,now(),now());
      INSERT INTO org_members (org_id,user_id,role) VALUES ('${org}','alice','member');
      INSERT INTO packages (id,type) VALUES ('@upgrade/agent','agent');
      INSERT INTO runs (id,package_id,org_id,space_id,user_id,status)
        VALUES ('run1','@upgrade/agent','${org}','spaceA','alice','failed');
      INSERT INTO notifications (org_id,space_id,recipient_type,recipient_id,type,run_id,payload)
        VALUES ('${org}','spaceB','user','alice','run_completed','run1','{"status":"failed"}'),
               ('${otherOrg}','spaceB','user','unverified','run_completed','run1','{"status":"failed"}');
    `);
    expect(await pending()).toEqual([
      { check: "0052 · notifications outside their run's organization or space", pending: 2 },
    ]);
    await pg.exec(repair);
    expect((await pending())[0]?.pending).toBe(1);
    // A partially upgraded installation must get the same diagnosis under the renamed type.
    await pg.exec("UPDATE notifications SET space_id = 'spaceB' WHERE recipient_id = 'alice'");
    const dir = new URL("../../packages/db/drizzle/", import.meta.url);
    const journal = await Bun.file(new URL("meta/_journal.json", dir)).json();
    for (const { tag } of journal.entries.slice(97)) {
      const sql = await Bun.file(new URL(tag + ".sql", dir)).text();
      await pg.transaction((tx) => tx.exec(sql.replaceAll("--> statement-breakpoint", "")));
    }
    expect((await pending())[0]?.pending).toBe(2);
    await pg.exec(repair);
    expect((await pending())[0]?.pending).toBe(1);
    await pg.exec(repair);
    expect(
      (await pg.query("SELECT space_id FROM notifications WHERE recipient_id = 'unverified'")).rows,
    ).toEqual([{ space_id: "spaceB" }]);
    // The operator reconciles the deliberately ambiguous fixture before copying any read state.
    await pg.exec("DELETE FROM notifications WHERE recipient_id = 'unverified'");
    expect(await pending()).toEqual([]);
    await pg.exec(
      await Bun.file(new URL("../migration/0052-run-reads.sql", import.meta.url)).text(),
    );
    expect((await pg.query("SELECT org_id, space_id, recipient_id FROM run_reads")).rows).toEqual([
      { org_id: org, space_id: "spaceA", recipient_id: "alice" },
    ]);
  } finally {
    await pg.close();
  }
});

it("names a stored chat message whose parts is not an array instead of failing before-traffic", async () => {
  await truncateAll();
  const { orgId, user } = await createTestContext();
  const sessionId = `chs_${crypto.randomUUID()}`;
  await db.insert(chatSessions).values({ id: sessionId, orgId, userId: user.id });
  // Matches the 0055 candidate filter (appfile:// and read_file) with an object `parts`.
  const content = {
    role: "assistant",
    parts: { type: "tool-read_file", input: { uri: "appfile://file_1" } },
  };
  await db.execute(sql`
    INSERT INTO chat_messages (session_id, message_id, content)
    VALUES (${sessionId}, 'object-parts', ${JSON.stringify(content)}::jsonb)
  `);
  const [row] = await db
    .select({ seq: chatMessages.seq })
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId));
  const checks = await checkBeforeTraffic(new Date("2026-01-01T00:00:00Z"));
  expect(checks.find(({ check }) => check.startsWith("0055"))?.pending).toBe(0);
  expect(checks.find(({ check }) => check.startsWith("chat ·"))).toEqual({
    check: "chat · messages incompatible with history replay",
    pending: 1,
    identifiers: [`session_id=${sessionId} seq=${row!.seq}`],
  });
});
