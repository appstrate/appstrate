// SPDX-License-Identifier: Apache-2.0

/**
 * The durable half of the per-org RFC 8707 audience model: the `oauth_resources`
 * row that makes `${APP_URL}/api/mcp/o/<orgId>` mintable by the AS.
 *
 * The module owns one row per organization, written on `onOrgCreate`, removed on
 * `onOrgDelete`, and reconciled against the `organizations` roster at `init()`
 * and on the periodic tick. Both directions are asserted here, including the
 * sweep's blast radius: a row outside the per-org prefix is not the module's to
 * delete.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { oauthResource } from "@appstrate/db/schema";
import { db, truncateAll } from "../../../../../test/helpers/db.ts";
import { createTestContext } from "../../../../../test/helpers/auth.ts";
import { getMcpOrgResourceUri } from "../../../../lib/audiences.ts";
import mcpModule from "../../index.ts";

// `oauth_resources` is deliberately outside `truncateAll` — the AS seeds the two
// static platform identifiers once per process — so this file owns the lifecycle
// of every row it writes.
const ORPHAN_ORG_ID = "00000000-0000-0000-0000-0000000000b1";
const UNRELATED_IDENTIFIER = "https://resource.example.test/unrelated";

async function identifiers(values: string[]): Promise<string[]> {
  const rows = await db
    .select({ identifier: oauthResource.identifier })
    .from(oauthResource)
    .where(inArray(oauthResource.identifier, values));
  return rows.map((r) => r.identifier);
}

describe("per-org MCP audience rows", () => {
  let ownedIdentifiers: string[] = [];

  beforeEach(async () => {
    await truncateAll();
    ownedIdentifiers = [getMcpOrgResourceUri(ORPHAN_ORG_ID), UNRELATED_IDENTIFIER];
    await db.delete(oauthResource).where(inArray(oauthResource.identifier, ownedIdentifiers));
  });

  afterEach(async () => {
    await db.delete(oauthResource).where(inArray(oauthResource.identifier, ownedIdentifiers));
  });

  it("writes the row on org creation and removes it on org deletion", async () => {
    const ctx = await createTestContext({ orgSlug: "mcpaud1" });
    const uri = getMcpOrgResourceUri(ctx.orgId);
    ownedIdentifiers.push(uri);

    await mcpModule.events!.onOrgCreate!(ctx.orgId, ctx.user.email);
    expect(await identifiers([uri])).toEqual([uri]);

    // Idempotent — the periodic reconcile re-runs the same insert.
    await mcpModule.events!.onOrgCreate!(ctx.orgId, ctx.user.email);
    expect(await identifiers([uri])).toEqual([uri]);

    await mcpModule.events!.onOrgDelete!(ctx.orgId);
    expect(await identifiers([uri])).toEqual([]);
  });

  it("reconciles both directions against the organizations roster", async () => {
    const ctx = await createTestContext({ orgSlug: "mcpaud2" });
    const liveUri = getMcpOrgResourceUri(ctx.orgId);
    const orphanUri = getMcpOrgResourceUri(ORPHAN_ORG_ID);
    ownedIdentifiers.push(liveUri);

    // A row for an org that no longer exists — what a dropped `onOrgDelete`
    // leaves behind — plus a row outside the per-org prefix.
    await db.insert(oauthResource).values([
      { id: crypto.randomUUID(), identifier: orphanUri, name: "orphaned org endpoint" },
      { id: crypto.randomUUID(), identifier: UNRELATED_IDENTIFIER, name: "not ours" },
    ]);
    await db.delete(oauthResource).where(eq(oauthResource.identifier, liveUri));

    // `init()` ignores its context argument; the reconcile is what is under test.
    await (mcpModule.init as () => Promise<void>)();

    expect(await identifiers([liveUri, orphanUri, UNRELATED_IDENTIFIER])).toEqual(
      expect.arrayContaining([liveUri, UNRELATED_IDENTIFIER]),
    );
    expect(await identifiers([orphanUri])).toEqual([]);
  });
});
