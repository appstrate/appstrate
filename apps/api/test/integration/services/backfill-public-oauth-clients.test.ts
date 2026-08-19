// SPDX-License-Identifier: Apache-2.0

/**
 * The one-shot canonicalisation of legacy public OAuth clients
 * (`services/backfill-public-oauth-clients.ts`).
 *
 * Rows written before `integration_oauth_clients.token_endpoint_auth_method`
 * encrypted an EMPTY secret instead of declaring `none`, and only a decryption
 * can tell that row apart from a confidential one — which is why this is a
 * script and not a SQL migration.
 *
 * The property that matters most here is what it does NOT do: a row whose
 * ciphertext no longer opens is reported and left alone. Declaring `none` for
 * it would turn a confidential client into a public one silently, and hand the
 * connect flow an empty `client_secret` for a client that has a real one.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { encryptCredentials } from "@appstrate/connect";
import { integrationOauthClients } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import {
  backfillPublicOAuthClients,
  decideUndeclaredClient,
} from "../../../src/services/backfill-public-oauth-clients.ts";

const INTEGRATION = "@bfrorg/probe";

/**
 * Structurally a v1 envelope — it satisfies the `ioc_public_iff_no_secret`
 * CHECK, which only sees a non-empty string — but not one this key can open.
 */
const UNREADABLE_CIPHERTEXT = "v1.notarealkid.bm90LWEtcmVhbC1jaXBoZXJ0ZXh0";

describe("backfill of legacy public OAuth clients", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "bfrorg" });
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
    });
  });

  /**
   * Insert a row the way the pre-column code did: no declared method, always a
   * ciphertext. `isDefault` stays false so several rows can coexist under
   * `idx_ioc_one_default`.
   */
  async function seedUndeclaredClient(authKey: string, ciphertext: string): Promise<string> {
    const [row] = await db
      .insert(integrationOauthClients)
      .values({
        applicationId: ctx.defaultAppId,
        integrationId: INTEGRATION,
        authKey,
        clientId: `cid-${authKey}`,
        clientSecretEncrypted: ciphertext,
      })
      .returning({ id: integrationOauthClients.id });
    return row!.id;
  }

  async function storedRow(id: string) {
    const [row] = await db
      .select()
      .from(integrationOauthClients)
      .where(eq(integrationOauthClients.id, id));
    return row!;
  }

  it("declares a legacy empty-secret row public and clears its ciphertext", async () => {
    const id = await seedUndeclaredClient("legacy", encryptCredentials({ client_secret: "" }));

    const report = await backfillPublicOAuthClients();

    expect(report.scanned).toBe(1);
    expect(report.declaredPublic).toBe(1);
    expect(report.undecryptable).toEqual([]);
    const row = await storedRow(id);
    expect(row.tokenEndpointAuthMethod).toBe("none");
    expect(row.clientSecretEncrypted).toBe("");
  });

  it("leaves a row holding a real secret untouched", async () => {
    const ciphertext = encryptCredentials({ client_secret: "shh" });
    const id = await seedUndeclaredClient("confidential", ciphertext);

    const report = await backfillPublicOAuthClients();

    expect(report.leftConfidential).toBe(1);
    expect(report.declaredPublic).toBe(0);
    const row = await storedRow(id);
    // NULL is the correct end state: "the manifest decides".
    expect(row.tokenEndpointAuthMethod).toBeNull();
    expect(row.clientSecretEncrypted).toBe(ciphertext);
  });

  it("reports an unreadable ciphertext, changes nothing, and fails the run", async () => {
    const id = await seedUndeclaredClient("corrupt", UNREADABLE_CIPHERTEXT);

    const report = await backfillPublicOAuthClients();

    expect(report.undecryptable).toHaveLength(1);
    expect(report.undecryptable[0]).toMatchObject({
      id,
      integrationId: INTEGRATION,
      authKey: "corrupt",
    });
    expect(report.undecryptable[0]!.error.length).toBeGreaterThan(0);
    expect(report.declaredPublic).toBe(0);
    expect(report.leftConfidential).toBe(0);
    const row = await storedRow(id);
    expect(row.tokenEndpointAuthMethod).toBeNull();
    expect(row.clientSecretEncrypted).toBe(UNREADABLE_CIPHERTEXT);
  });

  it("still canonicalises the readable rows in a batch that contains an unreadable one", async () => {
    const legacyId = await seedUndeclaredClient(
      "legacy",
      encryptCredentials({ client_secret: "" }),
    );
    await seedUndeclaredClient("corrupt", UNREADABLE_CIPHERTEXT);

    const report = await backfillPublicOAuthClients();

    // One row nobody can read must not hide the rows that could be repaired.
    expect(report.scanned).toBe(2);
    expect(report.declaredPublic).toBe(1);
    expect(report.undecryptable).toHaveLength(1);
    expect((await storedRow(legacyId)).tokenEndpointAuthMethod).toBe("none");
  });

  it("writes nothing in dry-run while reporting the same verdicts", async () => {
    const ciphertext = encryptCredentials({ client_secret: "" });
    const id = await seedUndeclaredClient("legacy", ciphertext);

    const report = await backfillPublicOAuthClients({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.declaredPublic).toBe(1);
    const row = await storedRow(id);
    expect(row.tokenEndpointAuthMethod).toBeNull();
    expect(row.clientSecretEncrypted).toBe(ciphertext);
  });

  it("is idempotent — a second pass finds nothing left to declare", async () => {
    await seedUndeclaredClient("legacy", encryptCredentials({ client_secret: "" }));
    await seedUndeclaredClient("confidential", encryptCredentials({ client_secret: "shh" }));

    await backfillPublicOAuthClients();
    const second = await backfillPublicOAuthClients();

    // The confidential row stays undeclared by design, so it is still scanned;
    // what must not repeat is a write.
    expect(second.scanned).toBe(1);
    expect(second.declaredPublic).toBe(0);
    expect(second.leftConfidential).toBe(1);
  });
});

/**
 * The three-way verdict on its own, with the decryption injected: no database,
 * no encryption key, so the branch that must never guess is pinned directly.
 */
describe("decideUndeclaredClient", () => {
  it("calls an empty decrypted secret public", () => {
    expect(decideUndeclaredClient({ clientSecretEncrypted: "cipher" }, () => ({}))).toEqual({
      verdict: "public",
    });
    expect(
      decideUndeclaredClient({ clientSecretEncrypted: "cipher" }, () => ({ client_secret: "" })),
    ).toEqual({ verdict: "public" });
  });

  it("calls a non-empty decrypted secret confidential", () => {
    expect(
      decideUndeclaredClient({ clientSecretEncrypted: "cipher" }, () => ({ client_secret: "shh" })),
    ).toEqual({ verdict: "confidential" });
  });

  it("never converts a failed decryption into a verdict about the secret", () => {
    const decision = decideUndeclaredClient({ clientSecretEncrypted: "cipher" }, () => {
      throw new Error("unknown key id");
    });
    expect(decision).toEqual({ verdict: "undecryptable", error: "unknown key id" });
  });

  it("treats an already-empty ciphertext as public without decrypting", () => {
    expect(
      decideUndeclaredClient({ clientSecretEncrypted: "" }, () => {
        throw new Error("must not be called");
      }),
    ).toEqual({ verdict: "public" });
  });
});
