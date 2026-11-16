// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0055` + drizzle `0107` against the test database put back in the previous release's
 * shape (`chat_sessions.space_id`, no `chat_session_spaces`): every session comes out of the
 * pair touching its former space. `0107` refuses to drop the column while a session's space is
 * not recorded, a dry run writes nothing, the script is idempotent, and it refuses once the
 * column is gone. The test database is migrated past `0107`, so the old shape is rebuilt for
 * this file and `0107` is replayed at the end.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { db, toRows } from "@appstrate/db/client";
import {
  ColumnGone,
  copySessionSpaces,
  runCopySessionSpaces,
} from "../migration/0055-chat-sessions-touched-space.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";
import { seedSpace } from "../../apps/api/test/helpers/seed.ts";

const migration0107 = async () =>
  (
    await Bun.file(
      resolve(import.meta.dir, "../../packages/db/drizzle/0107_chat_session_spaces.sql"),
    ).text()
  )
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

const applyMigration = async () => {
  const statements = await migration0107();
  await db.transaction(async (tx) => {
    for (const statement of statements) await tx.execute(sql.raw(statement));
  });
};

const query = async (statement: string) =>
  toRows<Record<string, unknown>>(await db.execute(statement));

const recorded = async () =>
  (await query(`SELECT session_id, space_id FROM chat_session_spaces ORDER BY session_id`)).map(
    (row) => `${row.session_id}:${row.space_id}`,
  );

let ctx: TestContext;
let second: string;

beforeAll(async () => {
  // The previous release's shape.
  await db.execute(sql.raw(`DROP TABLE chat_session_spaces`));
  await db.execute(
    sql.raw(`ALTER TABLE chat_sessions ADD COLUMN space_id text
      CONSTRAINT chat_sessions_space_id_spaces_id_fk REFERENCES spaces(id) ON DELETE CASCADE`),
  );
  await db.execute(
    sql.raw(`CREATE INDEX idx_chat_sessions_space_user ON chat_sessions (space_id, user_id)`),
  );
  await truncateAll();
  ctx = await createTestContext({ orgSlug: "t0055" });
  second = (await seedSpace({ orgId: ctx.orgId, name: "Second" })).id;
  await db.execute(
    sql.raw(`INSERT INTO chat_sessions (id, org_id, user_id, space_id) VALUES
      ('chs_0055_a', '${ctx.orgId}', '${ctx.user.id}', '${ctx.defaultSpaceId}'),
      ('chs_0055_b', '${ctx.orgId}', '${ctx.user.id}', '${second}'),
      ('chs_0055_c', '${ctx.orgId}', '${ctx.user.id}', '${second}')`),
  );
});

afterAll(async () => {
  await truncateAll();
  // A database migrated past `0107` whatever the file left behind.
  if ((await query(`SELECT to_regclass('chat_session_spaces') AS t`))[0]!.t === null) {
    await applyMigration();
  } else if (
    (
      await query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'chat_sessions' AND column_name = 'space_id'`,
      )
    ).length > 0
  ) {
    await applyMigration();
  }
});

describe("scripts/migration/0055-chat-sessions-touched-space.ts", () => {
  it("migration 0107 refuses to drop the column while a session's space is unrecorded", async () => {
    await expect(applyMigration()).rejects.toThrow(/0055-chat-sessions-touched-space/);
    // The whole batch rolled back: the column is still there, the table never appeared.
    expect(
      (
        await query(
          `SELECT 1 FROM information_schema.columns WHERE table_name = 'chat_sessions' AND column_name = 'space_id'`,
        )
      ).length,
    ).toBe(1);
    expect((await query(`SELECT to_regclass('chat_session_spaces') AS t`))[0]!.t).toBeNull();
  });

  it("a dry run reports the copy and writes nothing", async () => {
    const lines: string[] = [];
    const counts = await runCopySessionSpaces({ apply: false, out: (line) => lines.push(line) });
    expect(counts).toEqual({ sessions: 3, copied: 3, unrecorded: 0 });
    expect(lines.join("\n")).toContain("DRY RUN");
    expect((await query(`SELECT to_regclass('chat_session_spaces') AS t`))[0]!.t).toBeNull();
  });

  it("--apply records each session's former space, and a second run writes nothing", async () => {
    const lines: string[] = [];
    expect(await runCopySessionSpaces({ apply: true, out: (line) => lines.push(line) })).toEqual({
      sessions: 3,
      copied: 3,
      unrecorded: 0,
    });
    expect(await recorded()).toEqual([
      `chs_0055_a:${ctx.defaultSpaceId}`,
      `chs_0055_b:${second}`,
      `chs_0055_c:${second}`,
    ]);
    expect(await runCopySessionSpaces({ apply: true, out: () => {} })).toEqual({
      sessions: 3,
      copied: 0,
      unrecorded: 0,
    });
  });

  it("a session written after the script trips the guard until the script runs again", async () => {
    await db.execute(
      sql.raw(`INSERT INTO chat_sessions (id, org_id, user_id, space_id)
        VALUES ('chs_0055_d', '${ctx.orgId}', '${ctx.user.id}', '${ctx.defaultSpaceId}')`),
    );
    await expect(applyMigration()).rejects.toThrow(/0055-chat-sessions-touched-space/);
    expect(await runCopySessionSpaces({ apply: true, out: () => {} })).toEqual({
      sessions: 4,
      copied: 1,
      unrecorded: 0,
    });
  });

  it("drizzle 0107 then drops the column and keeps every recorded space", async () => {
    await applyMigration();
    expect(
      (
        await query(
          `SELECT 1 FROM information_schema.columns WHERE table_name = 'chat_sessions' AND column_name = 'space_id'`,
        )
      ).length,
    ).toBe(0);
    expect(await recorded()).toEqual([
      `chs_0055_a:${ctx.defaultSpaceId}`,
      `chs_0055_b:${second}`,
      `chs_0055_c:${second}`,
      `chs_0055_d:${ctx.defaultSpaceId}`,
    ]);
  });

  it("the table the script created is the one 0107 declares", async () => {
    // 0107 ran over the script's table: same constraints and index, no duplicate.
    const constraints = (
      await query(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'chat_session_spaces'::regclass AND contype IN ('p', 'f') ORDER BY conname`,
      )
    ).map((row) => row.conname);
    expect(constraints).toEqual([
      "chat_session_spaces_session_id_chat_sessions_id_fk",
      "chat_session_spaces_session_id_space_id_pk",
      "chat_session_spaces_space_id_spaces_id_fk",
    ]);
  });

  it("refuses once the column is gone", async () => {
    await expect(copySessionSpaces(query)).rejects.toBeInstanceOf(ColumnGone);
  });
});
