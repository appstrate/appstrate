// SPDX-License-Identifier: Apache-2.0

/**
 * Widening a space-scoped connection to the org sets `origin_space_id`, whose foreign-key check
 * share-locks the space; so do inserting an org-scoped row there and sharing a row into it. A
 * space deletion locks the space, then cascades to its connections, clients and shares, so a
 * write that locked one of those rows first would deadlock against it: every such write must wait
 * on the space before it touches a row.
 */

import { beforeEach, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db, toRows } from "@appstrate/db/client";
import {
  integrationConnectionShares,
  integrationConnections,
  integrationOauthClients,
  spaces,
} from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { describeRequiresPostgres } from "../../helpers/tier.ts";
import { seedPackage, seedSpace } from "../../helpers/seed.ts";
import {
  persistCredentialBundle,
  promoteIntegrationOAuthClient,
} from "../../../src/services/integration-connections.ts";
import { shareConnection } from "../../../src/services/connection-shares.ts";
import { testCaller } from "../../helpers/connection-shares.ts";
import type { Permission } from "../../../src/lib/permissions.ts";

const INTEGRATION = "@lockorg/svc";
const AUTH = "google";

// Separate PostgreSQL connections are required: PGlite serializes transactions.
describeRequiresPostgres("a write naming a space locks the space before its rows", () => {
  let ctx: TestContext;
  let space: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "lockorg" });
    space = (await seedSpace({ orgId: ctx.orgId, name: "S" })).id;
    await seedPackage({ id: INTEGRATION, orgId: ctx.orgId, type: "integration" });
  });

  type Ids = { connection: string; client: string };

  /** A space's own client and a connection it minted there. */
  async function seedSpaceRow(): Promise<Ids> {
    const [client] = await db
      .insert(integrationOauthClients)
      .values({
        orgId: ctx.orgId,
        spaceId: space,
        integrationId: INTEGRATION,
        authKey: AUTH,
        clientId: "byo-app",
        clientSecretEncrypted: "x",
        isDefault: true,
      })
      .returning({ id: integrationOauthClients.id });
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION,
        authKey: AUTH,
        accountId: "default",
        orgId: ctx.orgId,
        spaceId: space,
        userId: ctx.user.id,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { access_token: "old" } }),
        clientRef: client!.id,
        label: "Connexion 1",
      })
      .returning({ id: integrationConnections.id });
    return { connection: row!.id, client: client!.id };
  }

  /** The seeded row now serves the whole org, connected from the space. */
  async function expectWidened(ids: Ids): Promise<void> {
    const [row] = await db
      .select({
        spaceId: integrationConnections.spaceId,
        originSpaceId: integrationConnections.originSpaceId,
      })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, ids.connection));
    expect(row).toEqual({ spaceId: null, originSpaceId: space });
  }

  const connectAndConfigure: ReadonlySet<Permission> = new Set<Permission>([
    "integrations:connect",
    "integrations:configure",
  ]);

  const widenings: Record<
    string,
    { write: (ids: Ids) => Promise<unknown>; expectDone: (ids: Ids) => Promise<void> }
  > = {
    "a client promotion": {
      write: ({ client }) =>
        promoteIntegrationOAuthClient({ orgId: ctx.orgId, spaceId: space }, INTEGRATION, client),
      expectDone: expectWidened,
    },
    "a session reconnect through a system client": {
      write: ({ connection }) =>
        persistCredentialBundle(
          {
            kind: "update-owned",
            scope: { orgId: ctx.orgId, spaceId: space },
            actor: { type: "user", id: ctx.user.id },
            connectionId: connection,
            packageId: INTEGRATION,
            authKey: AUTH,
          },
          { credentials: { access_token: "new" }, clientRef: "lock-system" },
        ),
      expectDone: expectWidened,
    },
    "an insert": {
      write: () =>
        persistCredentialBundle(
          {
            kind: "insert",
            scope: { orgId: ctx.orgId, spaceId: space },
            actor: { type: "user", id: ctx.user.id },
          },
          {
            credentials: { access_token: "fresh" },
            packageId: INTEGRATION,
            authKey: AUTH,
            accountId: "acct-inserted",
          },
        ),
      expectDone: async () => {
        const [row] = await db
          .select({
            spaceId: integrationConnections.spaceId,
            originSpaceId: integrationConnections.originSpaceId,
          })
          .from(integrationConnections)
          .where(eq(integrationConnections.accountId, "acct-inserted"));
        expect(row).toEqual({ spaceId: null, originSpaceId: space });
      },
    },
    "a share": {
      write: ({ connection }) =>
        shareConnection({
          connectionId: connection,
          spaceId: space,
          integrationId: INTEGRATION,
          caller: testCaller(
            { kind: "person", actor: { type: "user", id: ctx.user.id } },
            { spaceId: space, governs: true, permissionsIn: async () => connectAndConfigure },
          ),
        }),
      expectDone: async ({ connection }) => {
        const rows = await db
          .select({ spaceId: integrationConnectionShares.spaceId })
          .from(integrationConnectionShares)
          .where(eq(integrationConnectionShares.connectionId, connection));
        expect(rows).toEqual([{ spaceId: space }]);
      },
    },
  };

  for (const [path, { write, expectDone }] of Object.entries(widenings)) {
    it(`${path} waits on a deleting space before locking its rows`, async () => {
      const ids = await seedSpaceRow();
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      // The first lock a space deletion takes, held open.
      const deletion = db.transaction(async (tx) => {
        await tx.select({ id: spaces.id }).from(spaces).where(eq(spaces.id, space)).for("update");
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      let settled = false;
      const outcome = write(ids).then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        let waiting = false;
        const deadline = Date.now() + 5000;
        while (!settled && !waiting && Date.now() < deadline) {
          const rows = toRows<{ waiting: boolean }>(
            await db.execute(sql`
              SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database() AND pid <> pg_backend_pid()
                  AND wait_event_type = 'Lock') AS waiting
            `),
          );
          waiting = rows[0]!.waiting;
          if (!settled && !waiting) await Bun.sleep(10);
        }
        expect(settled).toBe(false);
        expect(waiting).toBe(true);
        // The deletion's cascade locks these rows next: the waiting widening must not hold them.
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT 1 FROM ${integrationConnections} WHERE ${integrationConnections.id} = ${ids.connection} FOR UPDATE NOWAIT`,
          );
          await tx.execute(
            sql`SELECT 1 FROM ${integrationOauthClients} WHERE ${integrationOauthClients.id} = ${ids.client} FOR UPDATE NOWAIT`,
          );
        });
      } finally {
        release.resolve();
        await deletion;
      }
      expect(await outcome).toBeNull();
      await expectDone(ids);
    });
  }
});
