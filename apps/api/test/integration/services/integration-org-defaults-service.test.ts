// SPDX-License-Identifier: Apache-2.0

/**
 * E-extra — integration org-defaults service.
 *
 * Default connection set per (space, integration): the cross-agent
 * governance baseline. CRUD round-trip + org isolation.
 *
 * `upsertOrgDefault` delegates target validation to `validatePinTargets`
 * (shared-only), so the seeded connection must serve the space, be shared
 * into it, and reference the integration.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpace } from "../../helpers/seed.ts";
import { seedShares } from "../../helpers/connection-shares.ts";
import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import {
  upsertOrgDefault,
  getOrgDefault,
  listOrgDefaultsForResolver,
  deleteOrgDefault,
} from "../../../src/services/integration-org-defaults-service.ts";
import type { SpaceScope } from "../../../src/lib/scope.ts";
import { isUserConnectionCreationBlocked } from "../../../src/services/integration-connection-resolver.ts";

const INTEGRATION_ID = "@official/gmail";

function integrationManifest(): Record<string, unknown> {
  return {
    schema_version: "0.1",
    type: "integration",
    name: INTEGRATION_ID,
    version: "1.0.0",
    display_name: "Gmail",
    source: { kind: "local", server: { name: "@official/gmail-server", version: "^1.0.0" } },
    auths: {
      primary: {
        type: "api_key",
        authorized_uris: ["https://api/*"],
        credentials: { schema: { type: "object", properties: { api_key: { type: "string" } } } },
        delivery: { http: { in: "header", name: "X-Api-Key", value: "{$credential.api_key}" } },
      },
    },
  };
}

describe("integration-org-defaults-service", () => {
  let ctx: TestContext;
  let scope: SpaceScope;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orgdef" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integrationManifest(),
    });
  });

  /** Seed an org-scope connection connected from `originSpaceId`, shared into `sharedSpaceIds`. */
  async function seedSharedConnection(
    originSpaceId = ctx.defaultSpaceId,
    label: string | null = null,
    sharedSpaceIds = [originSpaceId],
  ): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION_ID,
        authKey: "primary",
        accountId: "acct-shared",
        orgId: ctx.orgId,
        spaceId: null,
        originSpaceId,
        userId: ctx.user.id,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k" } }),
        scopesGranted: [],
        label: label ?? `Connexion ${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: integrationConnections.id });
    await seedShares(row!.id, sharedSpaceIds);
    return row!.id;
  }

  it("names a row shared here from any origin, never one shared only elsewhere", async () => {
    const other = (await seedSpace({ orgId: ctx.orgId, name: "Other" })).id;
    const sharedHere = await seedSharedConnection(other, null, [ctx.defaultSpaceId]);
    const sharedElsewhere = await seedSharedConnection(ctx.defaultSpaceId, null, [other]);

    const { orgDefault } = await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [sharedHere],
      enforce: false,
    });
    expect(orgDefault.connection_ids).toEqual([sharedHere]);
    await expect(
      upsertOrgDefault(scope, INTEGRATION_ID, {
        connectionIds: [sharedElsewhere],
        enforce: false,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("round-trips upsert → get → resolver-shape → delete (idempotent)", async () => {
    const connId = await seedSharedConnection();

    // upsert
    const { previous, orgDefault: created } = await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [connId],
      enforce: true,
    });
    expect(previous).toBeNull();
    expect(created.connection_ids).toEqual([connId]);
    expect(created.enforce).toBe(true);
    expect(await isUserConnectionCreationBlocked(ctx.defaultSpaceId, INTEGRATION_ID)).toBe(true);

    // get
    const fetched = await getOrgDefault(scope, INTEGRATION_ID);
    expect(fetched).not.toBeNull();
    expect(fetched!.connection_ids).toEqual([connId]);
    expect(fetched!.enforce).toBe(true);

    // listOrgDefaultsForResolver shape
    const resolverMap = await listOrgDefaultsForResolver(ctx.defaultSpaceId);
    expect(resolverMap[INTEGRATION_ID]).toEqual({ connectionIds: [connId], enforce: true });

    // delete
    const del = await deleteOrgDefault(scope, INTEGRATION_ID);
    expect(del.previous).toMatchObject({ connection_ids: [connId], enforce: true });
    expect(await getOrgDefault(scope, INTEGRATION_ID)).toBeNull();
    expect(await isUserConnectionCreationBlocked(ctx.defaultSpaceId, INTEGRATION_ID)).toBe(false);

    // delete is idempotent — second delete reports nothing removed.
    const del2 = await deleteOrgDefault(scope, INTEGRATION_ID);
    expect(del2.previous).toBeNull();
  });

  it("upsert replaces the existing default on the (app, integration) unique index", async () => {
    const connA = await seedSharedConnection();
    const connB = await seedSharedConnection();

    await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [connA],
      enforce: false,
    });
    const { previous, orgDefault: replaced } = await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [connB],
      enforce: true,
    });
    expect(previous).toMatchObject({ connection_ids: [connA], enforce: false });
    expect(replaced.connection_ids).toEqual([connB]);
    expect(replaced.enforce).toBe(true);

    const fetched = await getOrgDefault(scope, INTEGRATION_ID);
    expect(fetched!.connection_ids).toEqual([connB]);
    expect(fetched!.enforce).toBe(true);
  });

  it("a default is a SET: N connections in the caller's order, replaced wholesale", async () => {
    const a = await seedSharedConnection(ctx.defaultSpaceId, "a");
    const b = await seedSharedConnection(ctx.defaultSpaceId, "b");
    const c = await seedSharedConnection(ctx.defaultSpaceId, "c");
    const expected = [c, a, b];

    const { orgDefault: created } = await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: expected,
      enforce: true,
    });
    expect(created.connection_ids).toEqual(expected);
    expect(await listOrgDefaultsForResolver(ctx.defaultSpaceId)).toEqual({
      [INTEGRATION_ID]: { connectionIds: expected, enforce: true },
    });

    // Replacement, not a merge.
    await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [c],
      enforce: false,
    });
    const fetched = await getOrgDefault(scope, INTEGRATION_ID);
    expect(fetched!.connection_ids).toEqual([c]);
    expect(fetched!.enforce).toBe(false);
  });

  it("deleting a member leaves its id in the set — an enforced default never shrinks", async () => {
    const a = await seedSharedConnection(ctx.defaultSpaceId, "staging");
    const b = await seedSharedConnection(ctx.defaultSpaceId, "prod");
    await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [a, b],
      enforce: true,
    });
    await db.delete(integrationConnections).where(eq(integrationConnections.id, a));
    expect(await listOrgDefaultsForResolver(ctx.defaultSpaceId)).toEqual({
      [INTEGRATION_ID]: { connectionIds: [a, b], enforce: true },
    });
  });

  it("getOrgDefault returns null when no default is set", async () => {
    expect(await getOrgDefault(scope, INTEGRATION_ID)).toBeNull();
    expect(await listOrgDefaultsForResolver(ctx.defaultSpaceId)).toEqual({});
  });

  it("org isolation: one org cannot read another org's default", async () => {
    const connId = await seedSharedConnection();
    await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [connId],
      enforce: true,
    });

    // A second org with its own space — must not see org 1's default.
    const otherCtx = await createTestContext({ orgSlug: "orgdef-other" });
    const otherScope: SpaceScope = {
      orgId: otherCtx.orgId,
      spaceId: otherCtx.defaultSpaceId,
    };
    expect(await getOrgDefault(otherScope, INTEGRATION_ID)).toBeNull();
    expect(await listOrgDefaultsForResolver(otherCtx.defaultSpaceId)).toEqual({});
  });
});
