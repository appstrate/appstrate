// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0043` against the test database, one database across the cases: a dry run writes
 * nothing; the client of either tier minting the most connections wins, a tie going to the org-tier
 * one; the others are merged into it, and a space-tier winner is promoted; a merged client's
 * connections are re-pointed and flagged for reconnection; user-owned rows are widened, end users'
 * rows stay in their space; a second `--apply` finds nothing.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import { runPromoteAutoClientsToOrg } from "../migration/0043-promote-auto-clients-to-org.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";
import { seedEndUser, seedPackage, seedSpace } from "../../apps/api/test/helpers/seed.ts";

const DCR = "@mig0043/dcr";
const WITH_ORG = "@mig0043/with-org";
const BEATS_ORG = "@mig0043/beats-org";

let ctx: TestContext;
let s1: string;
let s2: string;
const lines: string[] = [];
const run = (apply: boolean) =>
  runPromoteAutoClientsToOrg({ apply, out: (line) => lines.push(line) });

async function seedAutoClient(
  integrationId: string,
  spaceId: string | null,
  issuer: string | null,
): Promise<string> {
  const [row] = await db
    .insert(integrationOauthClients)
    .values({
      orgId: ctx.orgId,
      spaceId,
      integrationId,
      authKey: "primary",
      clientId: `cid-${crypto.randomUUID().slice(0, 8)}`,
      clientSecretEncrypted: "",
      tokenEndpointAuthMethod: "none",
      autoProvisioned: true,
      issuer,
    })
    .returning({ id: integrationOauthClients.id });
  return row!.id;
}

async function seedConnection(
  integrationId: string,
  spaceId: string | null,
  clientRef: string,
  endUserId?: string,
): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId,
      authKey: "primary",
      accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
      orgId: ctx.orgId,
      spaceId,
      userId: endUserId ? null : ctx.user.id,
      endUserId: endUserId ?? null,
      credentialsEncrypted: "x",
      clientRef,
      label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
    })
    .returning({ id: integrationConnections.id });
  return row!.id;
}

async function clientsOf(integrationId: string) {
  const rows = await db
    .select()
    .from(integrationOauthClients)
    .where(inArray(integrationOauthClients.integrationId, [integrationId]));
  return new Map(rows.map((row) => [row.id, row]));
}

async function connectionsOf(ids: string[]) {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(inArray(integrationConnections.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

describe("0043 — space-tier auto clients moved to the org tier", () => {
  // DCR: two space-tier clients, no org one; `winner` holds the most connections.
  let winner: string;
  let loser: string;
  let winnerRows: string[];
  let loserRow: string;
  let endUserRow: string;
  // WITH_ORG: an org-tier client and two space-tier ones, one connection each: the tie goes to the org.
  let orgClient: string;
  let orgClientRow: string;
  let merged: string[];
  let mergedRows: string[];
  // BEATS_ORG: an org-tier client with one connection, a space-tier one with two.
  let beatenOrgClient: string;
  let beatenOrgRow: string;
  let spaceWinner: string;
  let spaceWinnerRows: string[];

  beforeAll(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "mig0043" });
    s1 = ctx.defaultSpaceId;
    s2 = (await seedSpace({ orgId: ctx.orgId })).id;
    for (const id of [DCR, WITH_ORG, BEATS_ORG]) {
      await seedPackage({ id, orgId: ctx.orgId, type: "integration" });
    }
    const issuer = "https://mcp.example.com";
    // The loser is the older: only its connection count makes `winner` win.
    loser = await seedAutoClient(DCR, s2, issuer);
    winner = await seedAutoClient(DCR, s1, issuer);
    winnerRows = [
      await seedConnection(DCR, s1, winner),
      await seedConnection(DCR, s1, winner),
      await seedConnection(DCR, s1, winner),
    ];
    loserRow = await seedConnection(DCR, s2, loser);
    const endUser = await seedEndUser({ orgId: ctx.orgId, spaceId: s2 });
    endUserRow = await seedConnection(DCR, s2, loser, endUser.id);

    orgClient = await seedAutoClient(WITH_ORG, null, null);
    orgClientRow = await seedConnection(WITH_ORG, null, orgClient);
    merged = [await seedAutoClient(WITH_ORG, s1, null), await seedAutoClient(WITH_ORG, s2, null)];
    mergedRows = [
      await seedConnection(WITH_ORG, s1, merged[0]!),
      await seedConnection(WITH_ORG, s2, merged[1]!),
    ];

    beatenOrgClient = await seedAutoClient(BEATS_ORG, null, null);
    beatenOrgRow = await seedConnection(BEATS_ORG, null, beatenOrgClient);
    spaceWinner = await seedAutoClient(BEATS_ORG, s1, null);
    spaceWinnerRows = [
      await seedConnection(BEATS_ORG, s1, spaceWinner),
      await seedConnection(BEATS_ORG, s1, spaceWinner),
    ];
  });

  it("(c) a dry run leaves the clients and connections as they are", async () => {
    const before = [await clientsOf(DCR), await clientsOf(WITH_ORG), await clientsOf(BEATS_ORG)];
    const all = [
      ...winnerRows,
      loserRow,
      endUserRow,
      orgClientRow,
      ...mergedRows,
      beatenOrgRow,
      ...spaceWinnerRows,
    ];
    const rowsBefore = await connectionsOf(all);

    await run(false);
    expect(lines[0]).toStartWith("database: ");
    expect(lines).toContain("to promote: 5");
    expect(lines).toContain(`org ${ctx.orgId}: promoted 2, merged 4, re-pointed 5, widened 8`);
    expect(lines.at(-1)).toContain("DRY RUN");
    expect([await clientsOf(DCR), await clientsOf(WITH_ORG), await clientsOf(BEATS_ORG)]).toEqual(
      before,
    );
    expect(await connectionsOf(all)).toEqual(rowsBefore);
  });

  it("(a) promotes the space client with the most connections and merges the other into it", async () => {
    lines.length = 0;
    await run(true);
    expect(lines.at(-1)).toBe("0043: APPLIED — committed.");
    expect(lines).toContain("space-tier auto clients left: 0");

    const clients = await clientsOf(DCR);
    expect([...clients.keys()]).toEqual([winner]);
    expect(clients.get(winner)!.spaceId).toBeNull();
    expect(clients.get(winner)!.isDefault).toBe(false);

    const rows = await connectionsOf([...winnerRows, loserRow, endUserRow]);
    for (const id of [loserRow, endUserRow]) {
      expect(rows.get(id)!.clientRef).toBe(winner);
      expect(rows.get(id)!.needsReconnection).toBe(true);
    }
    for (const id of winnerRows) {
      expect(rows.get(id)!.clientRef).toBe(winner);
      expect(rows.get(id)!.needsReconnection).toBe(false);
    }
    for (const id of [...winnerRows, loserRow]) {
      expect(rows.get(id)!.spaceId).toBeNull();
    }
    expect(rows.get(loserRow)!.originSpaceId).toBe(s2);
    expect(rows.get(endUserRow)!.spaceId).toBe(s2);
  });

  it("(b) merges every space client into an org-tier client that ties them", async () => {
    const clients = await clientsOf(WITH_ORG);
    expect([...clients.keys()]).toEqual([orgClient]);
    const rows = await connectionsOf([orgClientRow, ...mergedRows]);
    for (const id of mergedRows) {
      expect(rows.get(id)!.clientRef).toBe(orgClient);
      expect(rows.get(id)!.needsReconnection).toBe(true);
      expect(rows.get(id)!.spaceId).toBeNull();
    }
    expect(rows.get(orgClientRow)!.needsReconnection).toBe(false);
  });

  it("(e) a space client minting more connections beats the org-tier one, which is merged into it", async () => {
    const clients = await clientsOf(BEATS_ORG);
    expect([...clients.keys()]).toEqual([spaceWinner]);
    expect(clients.get(spaceWinner)!.spaceId).toBeNull();
    const rows = await connectionsOf([beatenOrgRow, ...spaceWinnerRows]);
    expect(rows.get(beatenOrgRow)!.clientRef).toBe(spaceWinner);
    expect(rows.get(beatenOrgRow)!.needsReconnection).toBe(true);
    for (const id of spaceWinnerRows) {
      expect(rows.get(id)!.clientRef).toBe(spaceWinner);
      expect(rows.get(id)!.needsReconnection).toBe(false);
      expect(rows.get(id)!.spaceId).toBeNull();
      expect(rows.get(id)!.originSpaceId).toBe(s1);
    }
  });

  it("(d) a second --apply finds nothing to promote", async () => {
    lines.length = 0;
    expect(await run(true)).toEqual([]);
    expect(lines).toContain("to promote: 0");
    expect(lines).toContain("space-tier auto clients left: 0");
  });
});
