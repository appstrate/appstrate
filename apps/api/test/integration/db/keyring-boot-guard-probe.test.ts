// SPDX-License-Identifier: Apache-2.0

/**
 * The LIVE half of the keyring boot guard (#1768): the default inventory boot actually runs,
 * against the test database. The decision itself is covered by injection in
 * `../../unit/keyring-boot-guard.test.ts`; a typo in the SQL or the adapter would refuse every
 * boot, and only a real database shows it.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { encrypt } from "@appstrate/connect";
import { orgProxies } from "@appstrate/db/schema";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";
import { assertKeyringCoversCiphertexts } from "../../../src/lib/boot.ts";

describe("assertKeyringCoversCiphertexts — live inventory", () => {
  let orgId: string;

  beforeEach(async () => {
    await truncateAll();
    ({ orgId } = await createTestContext({ orgSlug: "keyringorg" }));
  });

  it("boots on ciphertexts the configured keyring opens", async () => {
    await db.insert(orgProxies).values({ orgId, label: "P", urlEncrypted: encrypt("http://p") });
    expect(await assertKeyringCoversCiphertexts()).toBeUndefined();
  });

  it("refuses, naming the kid and its column, for one row under a missing kid", async () => {
    await db.insert(orgProxies).values({
      orgId,
      label: "P",
      urlEncrypted: `v1:k0gone:${Buffer.alloc(40).toString("base64")}`,
    });
    await expect(assertKeyringCoversCiphertexts()).rejects.toThrow(
      "'k0gone' in org_proxies.url_encrypted (1)",
    );
  });
});
