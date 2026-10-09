// SPDX-License-Identifier: Apache-2.0

/**
 * Label minting. Labels are unique per owner, integration and scope (the org,
 * or one space): "Connexion N" is one past the owner's highest N, never a row
 * count, and a named label the owner already holds gets the first free " (n)".
 * Two owners may hold the same label; the resolver disambiguates a bound set.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpace } from "../../helpers/seed.ts";
import { saveIntegrationConnection } from "../../../src/services/integration-connections.ts";
import { CONNECTION_LABEL_MAX } from "../../../src/lib/connection-label.ts";

const INTEGRATION = "@orga/pat";

describe("integration connection — label minting", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
    await seedPackage({ id: INTEGRATION, orgId: ctx.orgId, type: "integration", source: "local" });
  });

  function connect(
    userId: string,
    accountId = "default",
    labelHint?: string,
    spaceId = ctx.defaultSpaceId,
  ) {
    return saveIntegrationConnection(
      { orgId: ctx.orgId, spaceId },
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

  it("numbers per owner: two members each hold a Connexion 1", async () => {
    const other = await memberContext(ctx, "member");

    const mine = await connect(ctx.user.id);
    const theirs = await connect(other.user.id);

    expect(mine.label).toBe("Connexion 1");
    expect(theirs.label).toBe("Connexion 1");
  });

  it("numbers one org scope across the spaces the owner connects from", async () => {
    const team = await seedSpace({ orgId: ctx.orgId, name: "Team" });
    const first = await connect(ctx.user.id);
    const second = await connect(ctx.user.id, "default", undefined, team.id);

    expect(first.scope).toBe("org");
    expect(second.scope).toBe("org");
    expect(second.label).toBe("Connexion 2");
  });

  it("numbers the owner's space-scoped rows apart from their org rows", async () => {
    const [client] = await db
      .insert(integrationOauthClients)
      .values({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        integrationId: INTEGRATION,
        authKey: "pat",
        clientId: "space-client",
        clientSecretEncrypted: "unused",
      })
      .returning();
    await connect(ctx.user.id);
    const spaceRow = await saveIntegrationConnection(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      {
        packageId: INTEGRATION,
        authKey: "pat",
        accountId: "default",
        credentials: { token: "t" },
        actor: { type: "user", id: ctx.user.id },
        clientRef: client!.id,
      },
    );

    expect(spaceRow.scope).toBe("space");
    expect(spaceRow.label).toBe("Connexion 1");
  });

  it("strips control and bidi characters from an identity label, falling back to N when nothing remains", async () => {
    const named = await connect(ctx.user.id, "ops‮@example.com\n");
    expect(named.label).toBe("ops@example.com");

    const blank = await connect(ctx.user.id, "​⁦", "\n");
    expect(blank.label).toBe("Connexion 1");
  });

  it("suffixes an identity the owner holds with the first free (n), not one another owner holds", async () => {
    const other = await memberContext(ctx, "member");
    expect((await connect(other.user.id, "ops@example.com")).label).toBe("ops@example.com");
    expect((await connect(ctx.user.id, "ops@example.com")).label).toBe("ops@example.com");
    expect((await connect(ctx.user.id, "ops@example.com")).label).toBe("ops@example.com (2)");

    // A rename already took "(3)": it is skipped, not duplicated.
    const renamed = await connect(ctx.user.id, "other@example.com");
    await db
      .update(integrationConnections)
      .set({ label: "ops@example.com (3)" })
      .where(eq(integrationConnections.id, renamed.id));
    expect((await connect(ctx.user.id, "ops@example.com")).label).toBe("ops@example.com (4)");
  });

  it("suffixes a taken label hint too, and compares labels verbatim", async () => {
    expect((await connect(ctx.user.id, "default", "sk-…abcd")).label).toBe("sk-…abcd");
    expect((await connect(ctx.user.id, "default", "sk-…abcd")).label).toBe("sk-…abcd (2)");
    // Control: case makes a second label — the sidecar's enum is case-sensitive.
    expect((await connect(ctx.user.id, "default", "SK-…abcd")).label).toBe("SK-…abcd");
  });

  it("cuts an over-long identity to the max", async () => {
    const full = "a".repeat(CONNECTION_LABEL_MAX);
    expect((await connect(ctx.user.id, "default", `${full}bcdef`)).label).toBe(full);
  });

  it("cuts a max-length base so the suffixed label still fits the max", async () => {
    const full = "a".repeat(CONNECTION_LABEL_MAX);
    expect((await connect(ctx.user.id, "default", full)).label).toBe(full);

    const second = (await connect(ctx.user.id, "default", full)).label;
    expect(second).toBe(`${"a".repeat(CONNECTION_LABEL_MAX - 4)} (2)`);
    expect(second.length).toBe(CONNECTION_LABEL_MAX);
    // The cut base is compared too: "(2)" is taken, so the next is "(3)".
    expect((await connect(ctx.user.id, "default", full)).label).toBe(
      `${"a".repeat(CONNECTION_LABEL_MAX - 4)} (3)`,
    );
  });
});
