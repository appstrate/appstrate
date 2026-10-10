// SPDX-License-Identifier: Apache-2.0

/**
 * The durable half of the RFC 8707 audience model: the `oauth_resources` rows
 * that make `${APP_URL}/api/mcp/o/<orgId>` and `…/o/<orgId>/s/<spaceId>`
 * mintable by the AS.
 *
 * The module owns one row per organization, written on `onOrgCreate`, removed on
 * `onOrgDelete`, and reconciled against the `organizations` roster at `init()`
 * and on the periodic tick. A space's row is written on demand by the AS gate
 * (`ensureMcpResourceMintable`), kept by the reconcile while the space lives,
 * and removed with its org or once the space is gone. Both directions are
 * asserted here, including the sweep's blast radius: a row outside the MCP
 * prefix is not the module's to delete.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq, inArray, like } from "drizzle-orm";
import { oauthResource } from "@appstrate/db/schema";
import { db, truncateAll } from "../../../../../test/helpers/db.ts";
import { createTestContext } from "../../../../../test/helpers/auth.ts";
import { seedSpace } from "../../../../../test/helpers/seed.ts";
import { getMcpOrgResourceUri, getMcpSpaceResourceUri } from "../../../../lib/audiences.ts";
import { ensureMcpResourceMintable } from "../../oauth-resources.ts";
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

  /**
   * The sweep asks one question per row — "does an org still exist for this
   * identifier?" — and Postgres answers it against the live `organizations`
   * table inside the DELETE itself; no roster list is passed in. That is what
   * makes a concurrently created org safe: there is no window between reading
   * the roster and deleting against it.
   *
   * The interleaving itself cannot be staged in one process — it would need the
   * reconcile to pause between its two halves, and no seam here offers that. So
   * what is asserted is the per-row invariant the interleaving relies on, with
   * the live row's `id` carried through untouched: a row that was deleted and
   * re-inserted would come back under a fresh `crypto.randomUUID()`.
   */
  it("leaves a live org's existing row untouched while sweeping a dead org's", async () => {
    const ctx = await createTestContext({ orgSlug: "mcpaud3" });
    const liveUri = getMcpOrgResourceUri(ctx.orgId);
    const orphanUri = getMcpOrgResourceUri(ORPHAN_ORG_ID);
    ownedIdentifiers.push(liveUri);

    const liveRowId = crypto.randomUUID();
    await db.insert(oauthResource).values([
      { id: liveRowId, identifier: liveUri, name: "live org endpoint" },
      { id: crypto.randomUUID(), identifier: orphanUri, name: "orphaned org endpoint" },
      { id: crypto.randomUUID(), identifier: UNRELATED_IDENTIFIER, name: "not ours" },
    ]);

    await (mcpModule.init as () => Promise<void>)();

    const [live] = await db
      .select({ id: oauthResource.id })
      .from(oauthResource)
      .where(eq(oauthResource.identifier, liveUri));
    expect(live?.id).toBe(liveRowId);
    expect(await identifiers([orphanUri])).toEqual([]);
    expect(await identifiers([UNRELATED_IDENTIFIER])).toEqual([UNRELATED_IDENTIFIER]);
  });
});

describe("per-space MCP audience rows", () => {
  let orgUris: string[] = [];

  async function rowId(identifier: string): Promise<string | undefined> {
    const [row] = await db
      .select({ id: oauthResource.id })
      .from(oauthResource)
      .where(eq(oauthResource.identifier, identifier));
    return row?.id;
  }

  beforeEach(async () => {
    await truncateAll();
    orgUris = [];
  });

  afterEach(async () => {
    for (const uri of orgUris) {
      await db.delete(oauthResource).where(like(oauthResource.identifier, `${uri}%`));
    }
  });

  it("reconcile keeps a live space's row and sweeps a row whose space is gone", async () => {
    const ctx = await createTestContext({ orgSlug: "mcpspc1" });
    orgUris.push(getMcpOrgResourceUri(ctx.orgId));
    const space = await seedSpace({ orgId: ctx.orgId, name: "Live" });
    const liveUri = getMcpSpaceResourceUri(ctx.orgId, space.id);
    const goneUri = getMcpSpaceResourceUri(ctx.orgId, `spc_${crypto.randomUUID()}`);
    const liveRowId = crypto.randomUUID();
    await db.insert(oauthResource).values([
      { id: liveRowId, identifier: liveUri, name: "live space endpoint" },
      { id: crypto.randomUUID(), identifier: goneUri, name: "deleted space endpoint" },
    ]);

    await (mcpModule.init as () => Promise<void>)();

    expect(await rowId(liveUri)).toBe(liveRowId);
    expect(await identifiers([goneUri])).toEqual([]);
  });

  it("deletes the org row and its space rows on org deletion", async () => {
    const ctx = await createTestContext({ orgSlug: "mcpspc2" });
    const orgUri = getMcpOrgResourceUri(ctx.orgId);
    orgUris.push(orgUri);
    const space = await seedSpace({ orgId: ctx.orgId, name: "Doomed" });
    const spaceUri = getMcpSpaceResourceUri(ctx.orgId, space.id);
    await mcpModule.events!.onOrgCreate!(ctx.orgId, ctx.user.email);
    await ensureMcpResourceMintable(spaceUri);
    expect(await identifiers([orgUri, spaceUri])).toEqual(
      expect.arrayContaining([orgUri, spaceUri]),
    );

    await mcpModule.events!.onOrgDelete!(ctx.orgId);

    expect(await identifiers([orgUri, spaceUri])).toEqual([]);
  });

  it("writes a live space's row on demand, once", async () => {
    const ctx = await createTestContext({ orgSlug: "mcpspc3" });
    orgUris.push(getMcpOrgResourceUri(ctx.orgId));
    const space = await seedSpace({ orgId: ctx.orgId, name: "On demand" });
    const spaceUri = getMcpSpaceResourceUri(ctx.orgId, space.id);
    expect(await identifiers([spaceUri])).toEqual([]);

    await ensureMcpResourceMintable(spaceUri);
    const firstId = await rowId(spaceUri);
    expect(firstId).toBeDefined();

    await ensureMcpResourceMintable(spaceUri);
    expect(await rowId(spaceUri)).toBe(firstId);
  });

  it("writes no row for another org's space, a nonexistent space, or an org URI", async () => {
    const ctx = await createTestContext({ orgSlug: "mcpspc4" });
    const other = await createTestContext({ orgSlug: "mcpspc5" });
    const orgUri = getMcpOrgResourceUri(ctx.orgId);
    orgUris.push(orgUri, getMcpOrgResourceUri(other.orgId));
    const otherSpace = await seedSpace({ orgId: other.orgId, name: "Elsewhere" });
    const foreignUri = getMcpSpaceResourceUri(ctx.orgId, otherSpace.id);
    const missingUri = getMcpSpaceResourceUri(ctx.orgId, `spc_${crypto.randomUUID()}`);
    await db.delete(oauthResource).where(eq(oauthResource.identifier, orgUri));

    await ensureMcpResourceMintable(foreignUri);
    await ensureMcpResourceMintable(missingUri);
    await ensureMcpResourceMintable(orgUri);

    expect(await identifiers([foreignUri, missingUri, orgUri])).toEqual([]);
  });
});
