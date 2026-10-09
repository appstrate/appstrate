// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/rekey-encrypted-columns.ts` on a private PGlite replayed to the current
 * schema, with a real two-key keyring: every live ciphertext under the retired kid ends under the
 * active one with the same plaintext, a rerun is a no-op, and what the keyring cannot read is
 * counted and left alone.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { _resetCacheForTesting } from "@appstrate/env";
import { decrypt, encrypt } from "@appstrate/connect";
import { _resetKeyringForTesting } from "../../../../packages/connect/src/encryption.ts";
import { ENCRYPTED_COLUMNS, countByKid } from "@appstrate/db/encrypted-columns";
import {
  rekeyRetiredKids,
  reportCounts,
  type Query,
} from "../../../../scripts/rekey-encrypted-columns.ts";
import { journalPGlite } from "../helpers/journal.ts";

const ORG = "e0000000-0000-4000-8000-00000000d037";
const SPACE = "spc_d0370000-0000-4000-8000-000000000001";
const USER = "usr_rekey_alice";
const GMAIL = "@acmerekey/gmail";
const AGENT = "@acmerekey/agent";
const OLD_KEY = randomBytes(32).toString("base64");
const NEW_KEY = randomBytes(32).toString("base64");
const KEYRING = { activeKid: "k2", retiredKids: ["k1"] };
const ENV_KEYS = [
  "CONNECTION_ENCRYPTION_KEY",
  "CONNECTION_ENCRYPTION_KEY_ID",
  "CONNECTION_ENCRYPTION_KEYS",
] as const;

let pg: PGlite;
const query: Query = async (text, params) => (await pg.query(text, params)).rows as never;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function useKeyring(env: Record<(typeof ENV_KEYS)[number], string>): void {
  Object.assign(process.env, env);
  _resetCacheForTesting();
  _resetKeyringForTesting();
}

async function column(table: string, col: string, where: string): Promise<string> {
  const { rows } = await pg.query<{ v: string }>(
    `SELECT "${col}" AS v FROM ${table} WHERE ${where}`,
  );
  return rows[0]!.v;
}

const OLD: Record<string, string> = {};

beforeAll(async () => {
  pg = await journalPGlite();
  useKeyring({
    CONNECTION_ENCRYPTION_KEY: OLD_KEY,
    CONNECTION_ENCRYPTION_KEY_ID: "k1",
    CONNECTION_ENCRYPTION_KEYS: "{}",
  });
  for (const name of ["conn", "client", "model", "proxy", "run", "closed", "smtp", "social"]) {
    OLD[name] = encrypt(`secret-${name}`);
  }
  const alien = `v1:k0:${randomBytes(40).toString("base64")}`;
  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Zero37', 'zero-37');
    INSERT INTO spaces (id, org_id, name, is_default) VALUES ('${SPACE}', '${ORG}', 'Default', true);
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('${USER}', 'Alice', 'a-rekey@example.com', true, now(), now());
    INSERT INTO packages (id, type) VALUES ('${GMAIL}', 'integration'), ('${AGENT}', 'agent');
  `);
  const inserts: [string, unknown[]][] = [
    [
      `INSERT INTO integration_connections
         (id, integration_package_id, auth_key, account_id, org_id, space_id, user_id, credentials_encrypted, label)
       VALUES ('d0370000-0000-4000-8000-000000000001', $1, 'primary', 'a@acme.test', $6, $2, $3, $4, 'A'),
              ('d0370000-0000-4000-8000-000000000002', $1, 'primary', 'b@acme.test', $6, $2, $3, $5, 'B')`,
      [GMAIL, SPACE, USER, OLD.conn, alien, ORG],
    ],
    [
      `INSERT INTO integration_oauth_clients
         (org_id, integration_package_id, auth_key, client_id, client_secret_encrypted, token_endpoint_auth_method)
       VALUES ($1, $2, 'primary', 'confidential', $3, NULL), ($1, $2, 'other', 'public', '', 'none')`,
      [ORG, GMAIL, OLD.client],
    ],
    [
      `INSERT INTO model_provider_credentials (org_id, label, provider_id, credentials_encrypted)
       VALUES ($1, 'BYOK', 'openai', $2)`,
      [ORG, OLD.model],
    ],
    [
      `INSERT INTO org_proxies (org_id, label, url_encrypted) VALUES ($1, 'P', $2)`,
      [ORG, OLD.proxy],
    ],
    [
      `INSERT INTO runs (id, package_id, user_id, space_id, org_id, status, started_at,
                         sink_secret_encrypted, sink_expires_at, sink_closed_at)
       VALUES ('run_rekey_open', $1, $2, $3, $4, 'running', now(), $5, now() + interval '1 hour', NULL),
              ('run_rekey_closed', $1, $2, $3, $4, 'success', now(), $6, now() + interval '1 hour', now())`,
      [AGENT, USER, SPACE, ORG, OLD.run, OLD.closed],
    ],
    [
      `INSERT INTO space_smtp_configs (space_id, host, port, username, pass_encrypted, from_address)
       VALUES ($1, 'smtp.acme.test', 587, 'u', $2, 'no-reply@acme.test')`,
      [SPACE, OLD.smtp],
    ],
    [
      `INSERT INTO space_social_providers (space_id, provider, client_id, client_secret_encrypted)
       VALUES ($1, 'github', 'gh', $2)`,
      [SPACE, OLD.social],
    ],
  ];
  for (const [text, params] of inserts) await pg.query(text, params);
  useKeyring({
    CONNECTION_ENCRYPTION_KEY: NEW_KEY,
    CONNECTION_ENCRYPTION_KEY_ID: "k2",
    CONNECTION_ENCRYPTION_KEYS: JSON.stringify({ k1: OLD_KEY }),
  });
}, 300_000);

afterAll(async () => {
  await pg.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetCacheForTesting();
  _resetKeyringForTesting();
});

describe("rekey-encrypted-columns", () => {
  it("names every *_encrypted column of the schema", async () => {
    const { rows } = await pg.query<{ c: string }>(
      `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name LIKE '%\\_encrypted' ORDER BY 1`,
    );
    const listed = ENCRYPTED_COLUMNS.map((s) => `${s.table}.${s.column}`).sort();
    expect(rows.map((r) => r.c)).toEqual(listed);
  });

  it("counts live ciphertexts per kid, skipping public clients and closed sinks", async () => {
    const counts = await countByKid(query);
    expect(counts.filter((c) => c.kid === "k1").length).toBe(ENCRYPTED_COLUMNS.length);
    expect(counts.every((c) => c.kid === "k0" || c.count === 1)).toBe(true);
    expect(counts.find((c) => c.kid === "k0")).toMatchObject({
      table: "integration_connections",
      column: "credentials_encrypted",
      kid: "k0",
      count: 1,
    });
    const lines: string[] = [];
    expect(reportCounts(counts, KEYRING, (l) => lines.push(l))).toBe(false);
    expect(lines.some((l) => l.includes("k0 (UNKNOWN)"))).toBe(true);
    expect(lines.filter((l) => l.includes("k1 (retired, sample opens)"))).toHaveLength(
      ENCRYPTED_COLUMNS.length,
    );
  });

  it("re-encrypts the retired kid under the active one, plaintext unchanged", async () => {
    const result = await rekeyRetiredKids(query, { ...KEYRING, batchSize: 1 });
    expect(result).toEqual({ rekeyed: ENCRYPTED_COLUMNS.length, skipped: 0, failed: [] });

    const conn = await column(
      "integration_connections",
      "credentials_encrypted",
      "id = 'd0370000-0000-4000-8000-000000000001'",
    );
    expect(conn.startsWith("v1:k2:")).toBe(true);
    expect(decrypt(conn)).toBe("secret-conn");
    const social = await column("space_social_providers", "client_secret_encrypted", "true");
    expect(decrypt(social)).toBe("secret-social");
    expect(
      await column("integration_oauth_clients", "client_secret_encrypted", "auth_key = 'other'"),
    ).toBe("");
    // A closed sink is never verified again: left as it was.
    expect(await column("runs", "sink_secret_encrypted", "id = 'run_rekey_closed'")).toBe(
      OLD.closed!,
    );

    const counts = await countByKid(query);
    expect(counts.some((c) => c.kid === "k1")).toBe(false);
  });

  it("is a no-op the second time", async () => {
    const before = await column("org_proxies", "url_encrypted", "true");
    expect(await rekeyRetiredKids(query, { ...KEYRING, batchSize: 2 })).toEqual({
      rekeyed: 0,
      skipped: 0,
      failed: [],
    });
    expect(await column("org_proxies", "url_encrypted", "true")).toBe(before);
  });

  it("leaves a row the platform rewrote between the read and the write", async () => {
    const stale = encryptUnder(OLD_KEY, "k1", "stale");
    await pg.query("UPDATE org_proxies SET url_encrypted = $1", [stale]);
    const current = encrypt("written-by-the-platform");
    const racing: Query = async (text, params) => {
      if (text.trimStart().startsWith("UPDATE")) {
        await pg.query("UPDATE org_proxies SET url_encrypted = $1", [current]);
      }
      return query(text, params);
    };
    expect(await rekeyRetiredKids(racing, { ...KEYRING, batchSize: 10 })).toEqual({
      rekeyed: 0,
      skipped: 1,
      failed: [],
    });
    expect(await column("org_proxies", "url_encrypted", "true")).toBe(current);
  });

  it("binds the retired kids: one carrying SQL matches nothing", async () => {
    const retiredKids = ["x') OR true --"];
    expect(await rekeyRetiredKids(query, { retiredKids, batchSize: 10 })).toEqual({
      rekeyed: 0,
      skipped: 0,
      failed: [],
    });
  });

  it("reports a ciphertext the retired key cannot open, and moves on", async () => {
    await pg.query("UPDATE org_proxies SET url_encrypted = $1", [
      `v1:k1:${randomBytes(40).toString("base64")}`,
    ]);
    const result = await rekeyRetiredKids(query, { ...KEYRING, batchSize: 10 });
    expect(result.rekeyed).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toStartWith("org_proxies.url_encrypted ");
    const lines: string[] = [];
    expect(reportCounts(await countByKid(query), KEYRING, (l) => lines.push(l))).toBe(false);
    expect(lines).toContain("  org_proxies.url_encrypted  k1 (retired, SAMPLE DOES NOT OPEN): 1");
  });
});

/** A `k1` envelope written while `k2` is active — what a pre-rotation write looks like. */
function encryptUnder(key: string, kid: string, plaintext: string): string {
  useKeyring({
    CONNECTION_ENCRYPTION_KEY: key,
    CONNECTION_ENCRYPTION_KEY_ID: kid,
    CONNECTION_ENCRYPTION_KEYS: "{}",
  });
  const blob = encrypt(plaintext);
  useKeyring({
    CONNECTION_ENCRYPTION_KEY: NEW_KEY,
    CONNECTION_ENCRYPTION_KEY_ID: "k2",
    CONNECTION_ENCRYPTION_KEYS: JSON.stringify({ k1: OLD_KEY }),
  });
  return blob;
}
