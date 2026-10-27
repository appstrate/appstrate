// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0034` against the test database: an ActiveCampaign connection without `api_url`
 * gets one built from `account_name`, inside its encrypted envelope; a second run changes
 * nothing; a connection whose URL field would not render is listed and fails the run, in a dry
 * run as in `--apply`. The rendering rule itself is `unrenderableAuthorizedUriFields`'s.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections } from "@appstrate/db/schema";
import { decryptCredentials, encryptCredentialEnvelope } from "@appstrate/connect";
import { runIntegrationUrlAllowlists } from "../migration/0034-integration-url-allowlists.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";
import { seedPackage } from "../../apps/api/test/helpers/seed.ts";

const ACTIVECAMPAIGN = "@appstrate/activecampaign";
const WORDPRESS = "@appstrate/wordpress";

let ctx: TestContext;

async function seedConnection(integrationId: string, outputs: Record<string, unknown>) {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId,
      authKey: "primary",
      accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
      label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      credentialsEncrypted: encryptCredentialEnvelope({ outputs }),
    })
    .returning({ id: integrationConnections.id });
  return row!.id;
}

async function stored(id: string) {
  const [row] = await db
    .select({
      ciphertext: integrationConnections.credentialsEncrypted,
      updatedAt: integrationConnections.updatedAt,
    })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, id));
  return row!;
}

async function outputsOf(id: string): Promise<Record<string, unknown>> {
  const { ciphertext } = await stored(id);
  return decryptCredentials<{ outputs: Record<string, unknown> }>(ciphertext).outputs;
}

describe("0034 — per-connection URL allowlists", () => {
  /** Holds `account_name` only: the rewrite's case. */
  let fromAccount: string;
  /** Already holds an `api_url` the rewrite must not replace. */
  let withApiUrl: string;
  const lines: string[] = [];
  const run = (apply: boolean) =>
    runIntegrationUrlAllowlists({ apply, out: (line) => lines.push(line) });

  beforeEach(async () => {
    await truncateAll();
    lines.length = 0;
    ctx = await createTestContext({ orgSlug: "mig0034" });
    for (const id of [ACTIVECAMPAIGN, WORDPRESS]) {
      await seedPackage({ id, orgId: null, type: "integration", source: "system" });
    }
    fromAccount = await seedConnection(ACTIVECAMPAIGN, { account_name: "acme", api_key: "k" });
    withApiUrl = await seedConnection(ACTIVECAMPAIGN, {
      account_name: "acme",
      api_url: "https://acme.api-us2.com",
      api_key: "k",
    });
  });

  it("builds api_url from account_name in the envelope, keeping every other output", async () => {
    const untouched = await stored(withApiUrl);

    expect(await run(true)).toBe(0);

    expect(await outputsOf(fromAccount)).toEqual({
      account_name: "acme",
      api_key: "k",
      api_url: "https://acme.api-us1.com",
    });
    expect(await stored(withApiUrl)).toEqual(untouched);
    expect(lines).toContain(
      `  rewrite ${ACTIVECAMPAIGN} ${fromAccount}: api_url from account_name`,
    );
  });

  it("changes nothing on a second run", async () => {
    expect(await run(true)).toBe(0);
    const first = [await stored(fromAccount), await stored(withApiUrl)];
    lines.length = 0;

    expect(await run(true)).toBe(0);

    expect([await stored(fromAccount), await stored(withApiUrl)]).toEqual(first);
    expect(lines).toContain("2 connection(s) scanned, 0 rewritten, 0 refused");
  });

  it("lists a connection whose URL would be refused and exits 1, in a dry run as in --apply", async () => {
    const noSiteUrl = await seedConnection(WORDPRESS, { username: "u", password: "p" });
    const before = await stored(fromAccount);

    expect(await run(false)).toBe(1);

    expect(lines).toContain(`  REFUSED ${WORDPRESS} ${noSiteUrl}: site_url missing`);
    expect(lines).toContain("3 connection(s) scanned, 1 rewritten, 1 refused");
    // The dry run rolled back the rewrite it reported.
    expect(await stored(fromAccount)).toEqual(before);
    expect(lines.at(-1)).toContain("DRY RUN");

    expect(await run(true)).toBe(1);
  });
});
