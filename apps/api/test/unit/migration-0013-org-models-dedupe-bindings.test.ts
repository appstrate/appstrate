// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0013-org-models-dedupe-bindings.sql` — replayed against a
 * database one migration short of `0062_org_models_unique_binding.sql`, which
 * is the only place the fixture is seedable: the index the script exists to
 * make creatable refuses the duplicate it repairs.
 *
 * A fresh PGlite per case: the script is globally scoped (no org filter), so
 * cases cannot be isolated by using disjoint organizations inside one instance.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const MIGRATIONS_DIR = `${REPO_ROOT}/packages/db/drizzle`;

/** The script under test. Always re-read from disk — never inlined. */
const SCRIPT = `${REPO_ROOT}/scripts/migration/0013-org-models-dedupe-bindings.sql`;
/** The narrowing the script clears the way for. */
const MIGRATION_0062 = `${MIGRATIONS_DIR}/0062_org_models_unique_binding.sql`;

/** One short of `0062`, which is what keeps the duplicate seedable. */
const REPLAY_THROUGH = "0061_oauth_fk_indexes";

const ORG = "e0000000-0000-4000-8000-00000000d013";
const CRED = "c0000000-0000-4000-8000-00000000d013";
const KEEPER = "a0000000-0000-4000-8000-000000000001";
const LOSER = "a0000000-0000-4000-8000-000000000002";
const ALIAS_A = "a0000000-0000-4000-8000-00000000000a";
const ALIAS_B = "a0000000-0000-4000-8000-00000000000b";
/** A pointer that names a SYSTEM model, not a row — must survive untouched. */
const SYSTEM_MODEL = "claude-sonnet-4-5";
const SPACE = "spc_d0130000-0000-4000-8000-000000000001";
const USER = "usr_0013_owner";
const AGENT = "@zero-thirteen/agent";
const OTHER_AGENT = "@zero-thirteen/other";
const SCHEDULE = "sch_0013";

let pg: PGlite;

/**
 * Replay the journal up to and including `lastTag`, the way the Tier 0 runner
 * does (`apps/api/src/lib/pglite-migrate.ts`). Throws rather than stopping
 * silently if the tag is absent, so a renamed migration fails this file instead
 * of replaying past the narrowing and turning the seed into a `23505`.
 */
async function replayThrough(db: PGlite, lastTag: string): Promise<void> {
  const journal = (await Bun.file(`${MIGRATIONS_DIR}/meta/_journal.json`).json()) as {
    entries: { idx: number; tag: string }[];
  };
  for (const entry of journal.entries) {
    const source = await Bun.file(`${MIGRATIONS_DIR}/${entry.tag}.sql`).text();
    await db.transaction(async (tx) => {
      await tx.exec(source.replaceAll("--> statement-breakpoint", ""));
    });
    if (entry.tag === lastTag) return;
  }
  throw new Error(`journal has no entry tagged ${lastTag}`);
}

/**
 * Run an operator script (its own `BEGIN` / `COMMIT`) through the raw driver.
 *
 * A failure abandons the script before its `COMMIT` and leaves the session in
 * an aborted transaction that `25P02`s everything after it, so the rollback is
 * forced here.
 */
async function exec(sql: string): Promise<void> {
  try {
    await pg.exec(sql);
  } catch (error) {
    try {
      await pg.exec("ROLLBACK");
    } catch {
      /* nothing to roll back */
    }
    throw error;
  }
}

const runScript = async (): Promise<void> => exec(await Bun.file(SCRIPT).text());
const createUniqueIndex = async (): Promise<void> => exec(await Bun.file(MIGRATION_0062).text());

async function count(query: string): Promise<number> {
  const { rows } = await pg.query<{ n: number | string }>(query);
  return Number(rows[0]?.n ?? -1);
}

async function value(query: string): Promise<string | null> {
  const { rows } = await pg.query<{ v: string | null }>(query);
  return rows[0]?.v ?? null;
}

/**
 * Two un-aliased rows over one (credential, model) — the older one is the
 * keeper — with every pointer column naming the loser, plus two aliases over
 * the same binding and one pointer naming a system model.
 */
async function seed(): Promise<void> {
  await exec(`
    INSERT INTO organizations (id, name, slug, default_model_id)
      VALUES ('${ORG}', 'Zero Thirteen', 'zero-thirteen-0013', '${LOSER}');
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('${USER}', 'Owner', 'o-0013@example.com', true, now(), now());
    INSERT INTO spaces (id, org_id, name, is_default)
      VALUES ('${SPACE}', '${ORG}', 'Default', true);
    INSERT INTO model_provider_credentials (id, org_id, label, provider_id, credentials_encrypted)
      VALUES ('${CRED}', '${ORG}', 'OpenAI', 'openai', 'enc');
    INSERT INTO org_models (id, org_id, label, model_id, credential_id, aliased, created_at)
      VALUES ('${KEEPER}',  '${ORG}', 'GPT-5',       'gpt-5', '${CRED}', false, now() - interval '1 day'),
             ('${LOSER}',   '${ORG}', 'GPT-5 (2)',   'gpt-5', '${CRED}', false, now()),
             ('${ALIAS_A}', '${ORG}', 'House model', 'gpt-5', '${CRED}', true,  now()),
             ('${ALIAS_B}', '${ORG}', 'Draft model', 'gpt-5', '${CRED}', true,  now());
    INSERT INTO packages (id, org_id, type) VALUES
      ('${AGENT}', '${ORG}', 'agent'),
      ('${OTHER_AGENT}', '${ORG}', 'agent');
    INSERT INTO space_packages (space_id, package_id, model_id) VALUES
      ('${SPACE}', '${AGENT}', '${LOSER}'),
      ('${SPACE}', '${OTHER_AGENT}', '${SYSTEM_MODEL}');
    INSERT INTO package_schedules (id, package_id, user_id, org_id, space_id, cron_expression, model_id_override)
      VALUES ('${SCHEDULE}', '${AGENT}', '${USER}', '${ORG}', '${SPACE}', '0 * * * *', '${LOSER}');
    INSERT INTO llm_usage (source, org_id, model, real_model, request_id) VALUES
      ('proxy', '${ORG}', '${LOSER}', 'gpt-5', 'req_0013_a'),
      ('proxy', '${ORG}', '${LOSER}', 'gpt-5', 'req_0013_b'),
      ('proxy', '${ORG}', '${KEEPER}', 'gpt-5', 'req_0013_c');
  `);
}

beforeEach(async () => {
  pg = new PGlite();
  await replayThrough(pg, REPLAY_THROUGH);
  await seed();
  // The journal replay runs past the 15s default in `bunfig.toml` on a cold
  // machine, and an abandoned hook keeps replaying into an instance the next
  // run replays into again.
}, 300_000);

afterEach(async () => {
  await pg.close();
});

const unaliased = (id: string) =>
  count(`SELECT count(*)::int AS n FROM org_models WHERE id = '${id}' AND aliased = false`);

describe("scripts/migration/0013 — one org_models row per un-aliased binding", () => {
  it("keeps the oldest row, repoints every reference at it, and deletes the rest", async () => {
    // The fixture is the state `0062` refuses — assert that before repairing it,
    // so a passing repair cannot be a fixture that never held a duplicate.
    await expect(createUniqueIndex()).rejects.toThrow(/could not create unique index/i);

    await runScript();

    expect(await unaliased(KEEPER)).toBe(1);
    expect(await unaliased(LOSER)).toBe(0);

    expect(await value(`SELECT default_model_id AS v FROM organizations WHERE id = '${ORG}'`)).toBe(
      KEEPER,
    );
    expect(
      await value(`SELECT model_id AS v FROM space_packages WHERE package_id = '${AGENT}'`),
    ).toBe(KEEPER);
    expect(
      await value(`SELECT model_id_override AS v FROM package_schedules WHERE id = '${SCHEDULE}'`),
    ).toBe(KEEPER);
    // The ledger moves too — its two loser rows join the keeper's one, which is
    // the spend split this change exists to end.
    expect(await count(`SELECT count(*)::int AS n FROM llm_usage WHERE model = '${KEEPER}'`)).toBe(
      3,
    );

    // A pointer naming a SYSTEM model is not a row id and must not be rewritten.
    expect(
      await value(`SELECT model_id AS v FROM space_packages WHERE package_id = '${OTHER_AGENT}'`),
    ).toBe(SYSTEM_MODEL);

    // Aliases over the same binding are a deliberate public identity, not a
    // duplicate — both survive, and the partial index accepts them.
    expect(await count(`SELECT count(*)::int AS n FROM org_models WHERE aliased = true`)).toBe(2);
    await createUniqueIndex();
  });

  it("is idempotent — a second run changes nothing", async () => {
    await runScript();
    await runScript();

    expect(await unaliased(KEEPER)).toBe(1);
    expect(await value(`SELECT default_model_id AS v FROM organizations WHERE id = '${ORG}'`)).toBe(
      KEEPER,
    );
    expect(await count(`SELECT count(*)::int AS n FROM llm_usage WHERE model = '${KEEPER}'`)).toBe(
      3,
    );
  });
});
