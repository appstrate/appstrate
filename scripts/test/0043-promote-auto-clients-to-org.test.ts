// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0043` against the test database, one database across the cases: a dry run writes
 * nothing; without an org-tier auto client, the space-tier one with the most connections is
 * promoted and the others merged into it; with one, every space-tier client is merged into it; a
 * merged client's connections are re-pointed and flagged for reconnection; user-owned rows are
 * widened, end users' rows stay in their space; a second `--apply` finds nothing.
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
  spaceId: string,
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
  // WITH_ORG: an org-tier client and two space-tier ones.
  let orgClient: string;
  let merged: string[];
  let mergedRows: string[];

  beforeAll(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "mig0043" });
    s1 = ctx.defaultSpaceId;
    s2 = (await seedSpace({ orgId: ctx.orgId })).id;
    for (const id of [DCR, WITH_ORG]) {
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
    merged = [await seedAutoClient(WITH_ORG, s1, null), await seedAutoClient(WITH_ORG, s2, null)];
    mergedRows = [
      await seedConnection(WITH_ORG, s1, merged[0]!),
      await seedConnection(WITH_ORG, s2, merged[1]!),
    ];
  });

  it("(c) a dry run leaves the clients and connections as they are", async () => {
    const before = [await clientsOf(DCR), await clientsOf(WITH_ORG)];
    const all = [...winnerRows, loserRow, endUserRow, ...mergedRows];
    const rowsBefore = await connectionsOf(all);

    await run(false);
    expect(lines[0]).toStartWith("database: ");
    expect(lines).toContain("to promote: 4");
    expect(lines).toContain(`org ${ctx.orgId}: promoted 1, merged 3, re-pointed 4, widened 6`);
    expect(lines.at(-1)).toContain("DRY RUN");
    expect([await clientsOf(DCR), await clientsOf(WITH_ORG)]).toEqual(before);
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

  it("(b) merges every space client into the org-tier client that already exists", async () => {
    const clients = await clientsOf(WITH_ORG);
    expect([...clients.keys()]).toEqual([orgClient]);
    const rows = await connectionsOf(mergedRows);
    for (const id of mergedRows) {
      expect(rows.get(id)!.clientRef).toBe(orgClient);
      expect(rows.get(id)!.needsReconnection).toBe(true);
      expect(rows.get(id)!.spaceId).toBeNull();
    }
  });

  it("(d) a second --apply finds nothing to promote", async () => {
    lines.length = 0;
    expect(await run(true)).toEqual([]);
    expect(lines).toContain("to promote: 0");
    expect(lines).toContain("space-tier auto clients left: 0");
  });
});
