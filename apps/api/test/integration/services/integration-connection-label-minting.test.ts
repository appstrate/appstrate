// SPDX-License-Identifier: Apache-2.0

/**
 * "Connexion N" minting. Pins and org defaults bind shared connections of
 * several owners into one set, and a set's labels must be distinct — so N is
 * numbered per (space, integration) across every owner, one past the highest N
 * already minted, never a row count.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { saveIntegrationConnection } from "../../../src/services/integration-connections.ts";

const INTEGRATION = "@orga/pat";

describe("integration connection — label minting", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
    await seedPackage({ id: INTEGRATION, orgId: ctx.orgId, type: "integration", source: "local" });
  });

  function connect(userId: string, accountId = "default", labelHint?: string) {
    return saveIntegrationConnection(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      {
        packageId: INTEGRATION,
        authKey: "pat",
        accountId,
        credentials: { token: "t" },
        actor: { type: "user", id: userId },
        ...(labelHint !== undefined ? { labelHint } : {}),
      },
    );
  }

  it("mints a fresh N after a deletion instead of reusing a live one", async () => {
    const first = await connect(ctx.user.id);
    await connect(ctx.user.id);
    const third = await connect(ctx.user.id);
    expect(third.label).toBe("Connexion 3");

    await db.delete(integrationConnections).where(eq(integrationConnections.id, first.id));
    const next = await connect(ctx.user.id);

    // A count would say 3 again — the label "Connexion 3" still in use.
    expect(next.label).toBe("Connexion 4");
  });

  it("numbers across owners, so two members' connections never share a label", async () => {
    const other = await memberContext(ctx, "member");

    const mine = await connect(ctx.user.id);
    const theirs = await connect(other.user.id);

    expect(mine.label).toBe("Connexion 1");
    expect(theirs.label).toBe("Connexion 2");
  });

  it("strips control and bidi characters from an identity label, falling back to N when nothing remains", async () => {
    const named = await connect(ctx.user.id, "ops‮@example.com\n");
    expect(named.label).toBe("ops@example.com");

    const blank = await connect(ctx.user.id, "​⁦", "\n");
    expect(blank.label).toBe("Connexion 1");
  });
});
