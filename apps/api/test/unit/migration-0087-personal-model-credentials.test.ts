// SPDX-License-Identifier: Apache-2.0

/**
 * `0087_personal_model_credentials.sql` on a database at `0086`: an org model bound to a credential
 * takes that credential's provider, a model may lose its credential (`credential_id` NULL) but
 * never its provider, and a credential may be owned by a user (cascading with the account).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { journalPGlite } from "../helpers/journal.ts";

const MIGRATION = resolve(
  import.meta.dir,
  "../../../../packages/db/drizzle/0087_personal_model_credentials.sql",
);
const REPLAY_THROUGH = "0086_connection_org_scope";

const ORG = "e0000000-0000-4000-8000-00000000c087";
const ALICE = "usr_0087_alice";
const CRED_OPENAI = "c0870000-0000-4000-8000-000000000001";
const CRED_ANTHROPIC = "c0870000-0000-4000-8000-000000000002";
const CRED_ALICE = "c0870000-0000-4000-8000-000000000003";
const MODEL_OPENAI = "d0870000-0000-4000-8000-000000000001";
const MODEL_ANTHROPIC = "d0870000-0000-4000-8000-000000000002";
const MODEL_FREE = "d0870000-0000-4000-8000-000000000003";

let pg: PGlite;

/** The SQLSTATE `sql` fails with; null if it lands. */
async function errorCode(sql: string): Promise<string | null> {
  try {
    await pg.exec(sql);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

async function providerOf(modelId: string): Promise<string | null> {
  const { rows } = await pg.query<{ provider_id: string | null }>(
    `SELECT provider_id FROM org_models WHERE id = '${modelId}'`,
  );
  return rows[0]?.provider_id ?? null;
}

beforeAll(async () => {
  pg = await journalPGlite({ through: REPLAY_THROUGH });
  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Zero87', 'zero-87');
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
      ('${ALICE}', 'Alice', 'a-0087@example.com', true, now(), now());
    INSERT INTO model_provider_credentials (id, org_id, label, provider_id, credentials_encrypted) VALUES
      ('${CRED_OPENAI}', '${ORG}', 'OpenAI key', 'openai', 'x'),
      ('${CRED_ANTHROPIC}', '${ORG}', 'Anthropic key', 'anthropic', 'x');
    INSERT INTO org_models (id, org_id, label, model_id, credential_id) VALUES
      ('${MODEL_OPENAI}', '${ORG}', 'GPT', 'gpt-087', '${CRED_OPENAI}'),
      ('${MODEL_ANTHROPIC}', '${ORG}', 'Claude', 'claude-087', '${CRED_ANTHROPIC}');
  `);
  const source = await Bun.file(MIGRATION).text();
  await pg.transaction(async (tx) => {
    await tx.exec(source.replaceAll("--> statement-breakpoint", ""));
  });
  // A journal replay runs past the suite's 15s per-test timeout (`--timeout`).
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("0087 — personal model credentials", () => {
  it("gives each bound model its credential's provider", async () => {
    expect(await providerOf(MODEL_OPENAI)).toBe("openai");
    expect(await providerOf(MODEL_ANTHROPIC)).toBe("anthropic");
  });

  it("keeps provider_id mandatory while credential_id becomes optional", async () => {
    expect(
      await errorCode(`UPDATE org_models SET credential_id = NULL WHERE id = '${MODEL_OPENAI}'`),
    ).toBeNull();
    expect(await providerOf(MODEL_OPENAI)).toBe("openai");
    expect(
      await errorCode(
        `INSERT INTO org_models (id, org_id, label, model_id, provider_id, credential_id)
         VALUES ('${MODEL_FREE}', '${ORG}', 'Free', 'gpt-free', 'openai', NULL)`,
      ),
    ).toBeNull();
    expect(
      await errorCode(
        `INSERT INTO org_models (id, org_id, label, model_id) VALUES
         ('d0870000-0000-4000-8000-000000000004', '${ORG}', 'No provider', 'x')`,
      ),
    ).toBe("23502");
    expect(
      await errorCode(`UPDATE org_models SET provider_id = NULL WHERE id = '${MODEL_ANTHROPIC}'`),
    ).toBe("23502");
  });

  it("gives credentials an optional owner, indexed by owner", async () => {
    const column = await pg.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'model_provider_credentials' AND column_name = 'owner_user_id'`,
    );
    expect(column.rows).toEqual([{ data_type: "text", is_nullable: "YES" }]);
    const index = await pg.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_model_provider_credentials_owner'`,
    );
    expect(index.rows).toHaveLength(1);
    // Existing (organization) credentials keep a NULL owner.
    const orgRows = await pg.query(
      `SELECT 1 FROM model_provider_credentials WHERE id = '${CRED_OPENAI}' AND owner_user_id IS NULL`,
    );
    expect(orgRows.rows).toHaveLength(1);
  });

  it("deletes a personal credential with its owner, and keeps organization credentials", async () => {
    await pg.exec(`
      INSERT INTO model_provider_credentials (id, org_id, label, provider_id, credentials_encrypted, owner_user_id)
      VALUES ('${CRED_ALICE}', '${ORG}', 'Alice key', 'openai', 'x', '${ALICE}');
      DELETE FROM "user" WHERE id = '${ALICE}';
    `);
    const { rows } = await pg.query<{ id: string }>(
      `SELECT id FROM model_provider_credentials ORDER BY id`,
    );
    expect(rows.map((row) => row.id)).toEqual([CRED_OPENAI, CRED_ANTHROPIC]);
  });
});
