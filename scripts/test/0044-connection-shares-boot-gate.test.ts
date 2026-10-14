// SPDX-License-Identifier: Apache-2.0

/**
 * Boot refusal while `integration_connections.shared_space_ids` still holds shares — i.e. while
 * `scripts/migration/0044-connection-shares.ts` has not run on a database migrated past drizzle
 * `0089`. A fresh database boots, a database holding the column refuses with the operator command,
 * and the same database boots once `0044 --apply` has run, a skipped target space included.
 * See docs/NO_TRANSITIONAL_CODE.md §5 — this check must never repair.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "@appstrate/db/client";
import { integrationConnections } from "@appstrate/db/schema";
import { assertConnectionSharesCopied } from "../../apps/api/src/lib/boot.ts";
import { runConnectionShares } from "../migration/0044-connection-shares.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";
import { seedPackage } from "../../apps/api/test/helpers/seed.ts";

const INTEGRATION = "@gate0044/svc";
const COMMAND = /bun scripts\/migration\/0044-connection-shares\.ts --apply/;

let ctx: TestContext;

async function seedConnection(sharedSpaceIds: string[]): Promise<void> {
  await db.insert(integrationConnections).values({
    integrationId: INTEGRATION,
    authKey: "primary",
    accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
    orgId: ctx.orgId,
    spaceId: null,
    userId: ctx.user.id,
    credentialsEncrypted: "x",
    label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
    sharedSpaceIds,
  });
}

const apply0044 = () => runConnectionShares({ apply: true, out: () => {} });

describe("assertConnectionSharesCopied — injected count", () => {
  it("returns once no connection holds a share in the column", async () => {
    expect(await assertConnectionSharesCopied(async () => 0)).toBeUndefined();
  });

  it("refuses to boot, naming the count and the operator command", async () => {
    await expect(assertConnectionSharesCopied(async () => 3)).rejects.toThrow(
      /3 connection\(s\)[\s\S]*Refusing to boot[\s\S]*0044-connection-shares\.ts --apply/,
    );
  });

  it("propagates a failing probe instead of assuming the copy ran", async () => {
    const boom = new Error("connection terminated");
    await expect(assertConnectionSharesCopied(() => Promise.reject(boom))).rejects.toThrow(boom);
  });
});

describe("assertConnectionSharesCopied — live database", () => {
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "gate0044" });
    await seedPackage({ id: INTEGRATION, orgId: ctx.orgId, type: "integration" });
  });

  it("boots a database whose connections hold no share in the column", async () => {
    await seedConnection([]);
    expect(await assertConnectionSharesCopied()).toBeUndefined();
  });

  it("refuses while a share sits in the column, and boots once 0044 --apply has copied it", async () => {
    await seedConnection([ctx.defaultSpaceId]);
    await expect(assertConnectionSharesCopied()).rejects.toThrow(COMMAND);

    await runConnectionShares({ apply: false, out: () => {} });
    await expect(assertConnectionSharesCopied()).rejects.toThrow(/1 connection\(s\)/);

    expect((await apply0044()).inserted).toBe(1);
    expect(await assertConnectionSharesCopied()).toBeUndefined();
  });

  it("boots after 0044 --apply when the only entry names a space 0044 skips", async () => {
    await seedConnection([`spc_${crypto.randomUUID()}`]);
    await expect(assertConnectionSharesCopied()).rejects.toThrow(COMMAND);

    const copy = await apply0044();
    expect(copy.inserted).toBe(0);
    expect(copy.skipped).toHaveLength(1);
    expect(await assertConnectionSharesCopied()).toBeUndefined();
  });
});
