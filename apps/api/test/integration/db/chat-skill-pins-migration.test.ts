// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0112_chat_skill_pins` — the three chat skill modes (`auto` | `manual` | `strict`)
 * folded into `skill_discovery` + `pinned_skills`, with `skill_status` added.
 *
 * The tier-0 harness replays the chain against an empty database, where an UPDATE that fires on
 * every row and one that fires on none look the same. The stake is a conversation's pins: fold
 * too little and an `auto` conversation's kept-but-unused pins are injected after the upgrade;
 * fold too much and a `manual` or `strict` conversation loses the pins its user chose.
 *
 * The live test database is already past 0112 (`skill_mode` and its enum are gone), so each case
 * opens a transaction, puts `chat_sessions` back into its pre-0112 shape inside it, replays the
 * real SQL file, asserts, and rolls back: Postgres DDL is transactional, so the suite's schema
 * is untouched whether the case passes or throws. Same pattern as
 * `config-into-input-migration.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";

const MIGRATION = new URL(
  "../../../../../packages/db/drizzle/0112_chat_skill_pins.sql",
  import.meta.url,
).pathname;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type SkillMode = "auto" | "manual" | "strict";

/** Rolls the enclosing transaction back. Never escapes `inPre0112Schema`. */
class Rollback extends Error {}

/** `db.execute` yields `{ rows }` on the PGlite driver and a bare array on postgres.js. */
function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: unknown[] }).rows ?? result) as T[];
}

/**
 * Run `body` against `chat_sessions` rewound to just before 0112, then roll back. The rewind is
 * the exact inverse of the migration's DDL and nothing more: the fold is what the test is about,
 * so only the migration file performs it.
 */
async function inPre0112Schema(body: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(`CREATE TYPE "public"."chat_skill_mode" AS ENUM('auto', 'manual', 'strict')`),
      );
      await tx.execute(
        sql.raw(
          `ALTER TABLE "chat_sessions" ADD COLUMN "skill_mode" "chat_skill_mode" DEFAULT 'auto' NOT NULL`,
        ),
      );
      await tx.execute(sql.raw(`ALTER TABLE "chat_sessions" DROP COLUMN "skill_status"`));
      await tx.execute(sql.raw(`ALTER TABLE "chat_sessions" DROP COLUMN "skill_discovery"`));
      await body(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

async function replayMigration(tx: Tx): Promise<void> {
  const source = await Bun.file(MIGRATION).text();
  for (const statement of source.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (!trimmed) continue;
    await tx.execute(sql.raw(trimmed));
  }
}

// The Drizzle schema describes the POST-migration shape, so the seed names its columns in raw SQL.
async function seedSession(
  tx: Tx,
  ctx: TestContext,
  mode: SkillMode,
  pinned: readonly string[],
): Promise<string> {
  const id = `chs_${crypto.randomUUID().replace(/-/g, "")}`;
  await tx.execute(sql`
    INSERT INTO "chat_sessions" ("id", "org_id", "user_id", "skill_mode", "pinned_skills")
    VALUES (
      ${id}, ${ctx.orgId}, ${ctx.user.id}, ${mode}::"chat_skill_mode",
      ${`{${pinned.join(",")}}`}::text[]
    )
  `);
  return id;
}

interface SkillColumns {
  skill_discovery: boolean;
  pinned_skills: string[];
  skill_status: unknown;
}

async function skillColumnsOf(tx: Tx, id: string): Promise<SkillColumns> {
  const rows = rowsOf<SkillColumns>(
    await tx.execute(sql`
      SELECT "skill_discovery", "pinned_skills", "skill_status"
      FROM "chat_sessions" WHERE "id" = ${id}
    `),
  );
  return rows[0]!;
}

describe("migration 0112 — fold the chat skill modes into pins and discovery", () => {
  let ctx: TestContext;
  const PINS = ["@acme/a", "@acme/b"];

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chat-skill-pins" });
  });

  it("maps each mode to its pins and discovery, every pin with no status", async () => {
    await inPre0112Schema(async (tx) => {
      const autoPinned = await seedSession(tx, ctx, "auto", PINS);
      const autoEmpty = await seedSession(tx, ctx, "auto", []);
      const manual = await seedSession(tx, ctx, "manual", PINS);
      const strict = await seedSession(tx, ctx, "strict", PINS);

      await replayMigration(tx);

      const unattributed = { skill_status: {} };
      // `auto` kept its pins unused: injecting them after the upgrade would change the chat.
      expect(await skillColumnsOf(tx, autoPinned)).toEqual({
        skill_discovery: true,
        pinned_skills: [],
        ...unattributed,
      });
      expect(await skillColumnsOf(tx, autoEmpty)).toEqual({
        skill_discovery: true,
        pinned_skills: [],
        ...unattributed,
      });
      expect(await skillColumnsOf(tx, manual)).toEqual({
        skill_discovery: true,
        pinned_skills: PINS,
        ...unattributed,
      });
      // `strict` is discovery off; its pins stay.
      expect(await skillColumnsOf(tx, strict)).toEqual({
        skill_discovery: false,
        pinned_skills: PINS,
        ...unattributed,
      });
    });
  });

  it("drops `skill_mode` and its enum", async () => {
    await inPre0112Schema(async (tx) => {
      await replayMigration(tx);

      const columns = rowsOf<unknown>(
        await tx.execute(sql`
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'chat_sessions'
            AND column_name = 'skill_mode'
        `),
      );
      expect(columns).toHaveLength(0);
      const types = rowsOf<unknown>(
        await tx.execute(sql`SELECT 1 FROM pg_type WHERE typname = 'chat_skill_mode'`),
      );
      expect(types).toHaveLength(0);
    });
  });
});
