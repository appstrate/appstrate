// SPDX-License-Identifier: Apache-2.0

/**
 * `0055_schema_integrity_repairs.sql` must actually repair the four defects it
 * names, on a database that still HAS them.
 *
 * A replay alone cannot show that, and the distinction is the whole reason this
 * file exists next to `migration-schema-parity.test.ts`. That test compares the
 * replayed catalog to the declared schema, and both sides move together: revert
 * the schema edits AND delete 0055 and it stays green, because the code and the
 * database would agree again — on the broken shape. It guards the INVARIANT.
 * This file guards the FIX, by modelling the population 0055 exists for and
 * checking that the shipped `.sql` converges it. Same split as
 * `migration-index-parity.test.ts` and `0041`.
 *
 * The pre-0055 state is built by UNDOING 0055 against a fully replayed database
 * rather than by stopping the journal one entry short. Stopping short would
 * only reproduce a FRESH install's starting state; production's differs, and
 * the difference is the point — see below.
 *
 * ═══ THE `_fkey` / `_fk` DRIFT IS MODELLED ON PURPOSE ═══
 *
 * `audit_events` on production predates drizzle's `_fk` naming convention and
 * carries Postgres' own `_fkey` spelling. In beta.24 a migration ran
 * `DROP CONSTRAINT "audit_events_org_id_organizations_id_fk"` against it, the
 * name matched nothing, the statement errored 42704 and aborted the batch, and
 * the deploy failed at `appstrate-migrate` with the app never starting. Fresh
 * installs were fine; only the database with history drifted.
 *
 * So the FK is re-created here under the `_fkey` name, not the declared one.
 * A literal `DROP CONSTRAINT "<declared name>"` in 0055 passes every assertion
 * a fresh replay can make and fails this one — which is the only place the
 * beta.24 shape is reachable without a production dump.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { applyCorePGliteMigrations } from "../../src/lib/pglite-migrate.ts";

const MIGRATIONS_DIR = resolve(import.meta.dir, "../../../../packages/db/drizzle");

/** The migration under test. Always re-read from disk — never inlined. */
const MIGRATION = `${MIGRATIONS_DIR}/0055_schema_integrity_repairs.sql`;

/**
 * The two names whose 68- and 70-byte originals Postgres truncated at creation.
 * Written out as the TRUNCATED forms the catalog actually held; the first case
 * below proves they are what truncation produces rather than trusting the
 * transcription.
 */
const TRUNCATED = {
  integrationOrgDefaults: "integration_org_defaults_connection_id_integration_connections_",
  modelProviderPairings: "model_provider_pairings_credential_id_model_provider_credential",
} as const;

const DECLARED_BEFORE = {
  integrationOrgDefaults: "integration_org_defaults_connection_id_integration_connections_id_fk",
  modelProviderPairings: "model_provider_pairings_credential_id_model_provider_credentials_id_fk",
} as const;

const pg = new PGlite();

/** Run the migration the way the runner does — whole file, breakpoints stripped. */
async function applyMigration(): Promise<void> {
  const sql = await Bun.file(MIGRATION).text();
  // `SET LOCAL` outside a transaction block is a warning-and-no-op, and the
  // fences must behave the same here as they do inside drizzle's batch.
  await pg.transaction(async (tx) => {
    await tx.exec(sql.replaceAll("--> statement-breakpoint", ""));
  });
}

/** Foreign keys on `table`, as `name → ON DELETE action`. */
async function foreignKeys(table: string): Promise<Map<string, string>> {
  const { rows } = await pg.query<{ conname: string; confdeltype: string }>(
    `SELECT c.conname, c.confdeltype
     FROM pg_constraint c
     WHERE c.conrelid = to_regclass($1) AND c.contype = 'f'`,
    [`public.${table}`],
  );
  const actions: Record<string, string> = { a: "no action", c: "cascade", n: "set null" };
  return new Map(rows.map((row) => [row.conname, actions[row.confdeltype] ?? row.confdeltype]));
}

async function indexDefinition(name: string): Promise<string | undefined> {
  const { rows } = await pg.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1",
    [name],
  );
  return rows[0]?.indexdef;
}

async function columnNames(table: string): Promise<Set<string>> {
  const { rows } = await pg.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set(rows.map((row) => row.column_name));
}

beforeAll(async () => {
  await applyCorePGliteMigrations(MIGRATIONS_DIR, pg);
});

afterAll(async () => {
  await pg.close();
});

describe("0055 — schema integrity repairs", () => {
  it("Postgres silently truncates both overlong FK names at creation", async () => {
    // The evidence for section C, produced rather than asserted from memory:
    // ask this very Postgres what it does with a 68-byte constraint name.
    // Everything else in this file about truncation rests on it.
    await pg.exec(`
      CREATE TABLE _trunc_target (id uuid PRIMARY KEY);
      CREATE TABLE _trunc_source (id uuid PRIMARY KEY, connection_id uuid);
    `);
    await pg.exec(
      `ALTER TABLE _trunc_source ADD CONSTRAINT "${DECLARED_BEFORE.integrationOrgDefaults}"
       FOREIGN KEY (connection_id) REFERENCES _trunc_target(id)`,
    );
    const { rows } = await pg.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = to_regclass('public._trunc_source') AND contype = 'f'`,
    );
    expect(rows[0]?.conname).toBe(TRUNCATED.integrationOrgDefaults);
    expect(Buffer.byteLength(TRUNCATED.integrationOrgDefaults)).toBe(63);
    expect(Buffer.byteLength(DECLARED_BEFORE.integrationOrgDefaults)).toBe(68);
    expect(Buffer.byteLength(DECLARED_BEFORE.modelProviderPairings)).toBe(70);
    await pg.exec("DROP TABLE _trunc_source; DROP TABLE _trunc_target;");
  });

  it("drops the audit-log space FK whatever the database calls it", async () => {
    // Production's spelling, not the schema's — see the header.
    await pg.exec(
      `ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_space_id_fkey"
       FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE SET NULL`,
    );
    expect([...(await foreignKeys("audit_events")).keys()]).toEqual(["audit_events_space_id_fkey"]);

    await applyMigration();

    // Gone, and with it the SET NULL that blanked a deleted space's whole audit
    // trail. `space_id` survives as a denormalised value, like `org_id`.
    expect([...(await foreignKeys("audit_events")).keys()]).toEqual([]);
    expect(await columnNames("audit_events")).toContain("space_id");
  });

  it("creates the two space-leading indexes on a database that lacks them", async () => {
    for (const name of ["idx_notifications_space", "pkp_space"]) {
      await pg.query(`DROP INDEX IF EXISTS "${name}"`);
      expect(await indexDefinition(name)).toBeUndefined();
    }

    await applyMigration();

    // LEADING on `space_id` is the assertion, not mere presence: an index that
    // exists but leads on `org_id` cannot serve the cascade's only qual, which
    // is exactly the state the four pre-existing indexes were already in.
    for (const name of ["idx_notifications_space", "pkp_space"]) {
      const definition = await indexDefinition(name);
      expect(definition).toBeDefined();
      expect(definition).toMatch(/\(\s*space_id\s*\)/);
    }
    // And NON-partial: a predicate the cascade does not state is a predicate
    // the planner cannot prove, which is what made `idx_notifications_unread`
    // unusable for it in the first place.
    expect(await indexDefinition("idx_notifications_space")).not.toContain("WHERE");
    expect(await indexDefinition("pkp_space")).not.toContain("WHERE");
  });

  it("renames both truncated constraints, found by column rather than by name", async () => {
    await pg.exec(
      `ALTER TABLE "integration_org_defaults"
       RENAME CONSTRAINT "integration_org_defaults_connection_id_fk"
       TO "${TRUNCATED.integrationOrgDefaults}"`,
    );
    await pg.exec(
      `ALTER TABLE "model_provider_pairings"
       RENAME CONSTRAINT "model_provider_pairings_credential_id_fk"
       TO "${TRUNCATED.modelProviderPairings}"`,
    );

    await applyMigration();

    const orgDefaults = await foreignKeys("integration_org_defaults");
    expect(orgDefaults.has(TRUNCATED.integrationOrgDefaults)).toBe(false);
    // The action must survive the rename — `RENAME CONSTRAINT` is catalog-only,
    // and a drop-and-recreate here would have been a window with no FK at all.
    expect(orgDefaults.get("integration_org_defaults_connection_id_fk")).toBe("cascade");

    const pairings = await foreignKeys("model_provider_pairings");
    expect(pairings.has(TRUNCATED.modelProviderPairings)).toBe(false);
    expect(pairings.get("model_provider_pairings_credential_id_fk")).toBe("set null");
  });

  it("drops the two columns nothing reads", async () => {
    // `chat_messages.parent_id` / `format` were part of the same finding and are
    // NOT asserted here: `0054` owns them, on its own, and this file only ever
    // exercises the statements `0055` actually ships.
    await pg.exec(`
      ALTER TABLE "org_invitations" ADD COLUMN "accepted_by" text;
      ALTER TABLE "org_invitations" ADD COLUMN "accepted_at" timestamp with time zone;
    `);
    // The dependent index goes with its column, which is why 0055 does not name
    // it — production may well call it something else.
    await pg.exec(
      `CREATE INDEX "idx_org_invitations_accepted_by" ON "org_invitations" ("accepted_by")`,
    );

    await applyMigration();

    const invitations = await columnNames("org_invitations");
    expect(invitations.has("accepted_by")).toBe(false);
    expect(invitations.has("accepted_at")).toBe(false);
    expect(await indexDefinition("idx_org_invitations_accepted_by")).toBeUndefined();
  });

  it("re-applies without error or effect", async () => {
    // The OTHER population, stated explicitly rather than inherited from
    // whichever test ran first: every already-converged database, which after
    // this release is all of them. Drizzle wraps the whole pending batch in ONE
    // transaction, so anything raised on a second pass would abort every other
    // migration in the release and wedge the deploy.
    const before = {
      auditFks: [...(await foreignKeys("audit_events")).keys()],
      orgDefaults: [...(await foreignKeys("integration_org_defaults")).keys()].sort(),
      pairings: [...(await foreignKeys("model_provider_pairings")).keys()].sort(),
      notifications: await indexDefinition("idx_notifications_space"),
      persistence: await indexDefinition("pkp_space"),
      invitations: [...(await columnNames("org_invitations"))].sort(),
      messages: [...(await columnNames("chat_messages"))].sort(),
    };

    await applyMigration();

    expect([...(await foreignKeys("audit_events")).keys()]).toEqual(before.auditFks);
    expect([...(await foreignKeys("integration_org_defaults")).keys()].sort()).toEqual(
      before.orgDefaults,
    );
    expect([...(await foreignKeys("model_provider_pairings")).keys()].sort()).toEqual(
      before.pairings,
    );
    expect(await indexDefinition("idx_notifications_space")).toBe(before.notifications!);
    expect(await indexDefinition("pkp_space")).toBe(before.persistence!);
    expect([...(await columnNames("org_invitations"))].sort()).toEqual(before.invitations);
    expect([...(await columnNames("chat_messages"))].sort()).toEqual(before.messages);
  });
});
