// SPDX-License-Identifier: Apache-2.0

/**
 * E-extra — integration org-defaults service.
 *
 * Org-wide default connection per (space, integration): the cross-agent
 * governance baseline. CRUD round-trip + org isolation.
 *
 * `upsertOrgDefault` delegates target validation to `validatePinTarget` with
 * `requireShared: true`, so the seeded connection must be `sharedWithOrg=true`,
 * belong to the space, and reference the integration.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
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

  /** Seed a sharedWithOrg connection (the only valid org-default target). */
  async function seedSharedConnection(
    spaceId = ctx.defaultSpaceId,
    label: string | null = null,
  ): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION_ID,
        authKey: "primary",
        accountId: "acct-shared",
        spaceId,
        userId: ctx.user.id,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k" } }),
        scopesGranted: [],
        sharedWithOrg: true,
        label: label ?? `Connexion ${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  it("round-trips upsert → get → resolver-shape → delete (idempotent)", async () => {
    const connId = await seedSharedConnection();

    // upsert
    const created = await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [connId],
      enforce: true,
      createdBy: ctx.user.id,
    });
    expect(created.connection_ids).toEqual([connId]);
    expect(created.enforce).toBe(true);

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
    expect(del.deleted).toBe(true);
    expect(await getOrgDefault(scope, INTEGRATION_ID)).toBeNull();

    // delete is idempotent — second delete reports nothing removed.
    const del2 = await deleteOrgDefault(scope, INTEGRATION_ID);
    expect(del2.deleted).toBe(false);
  });

  it("upsert replaces the existing default on the (app, integration) unique index", async () => {
    const connA = await seedSharedConnection();
    const connB = await seedSharedConnection();

    await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [connA],
      enforce: false,
      createdBy: ctx.user.id,
    });
    const replaced = await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [connB],
      enforce: true,
      createdBy: ctx.user.id,
    });
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

    const created = await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: expected,
      enforce: true,
      createdBy: ctx.user.id,
    });
    expect(created.connection_ids).toEqual(expected);
    expect(await listOrgDefaultsForResolver(ctx.defaultSpaceId)).toEqual({
      [INTEGRATION_ID]: { connectionIds: expected, enforce: true },
    });

    // Replacement, not a merge.
    await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [c],
      enforce: false,
      createdBy: ctx.user.id,
    });
    const fetched = await getOrgDefault(scope, INTEGRATION_ID);
    expect(fetched!.connection_ids).toEqual([c]);
    expect(fetched!.enforce).toBe(false);
  });

  it("refuses a set whose members share a label, with the resolver's wording", async () => {
    const a = await seedSharedConnection(ctx.defaultSpaceId, "prod");
    const bSame = await seedSharedConnection(ctx.defaultSpaceId, "prod");
    await expect(
      upsertOrgDefault(scope, INTEGRATION_ID, {
        connectionIds: [a, bSame],
        enforce: true,
        createdBy: ctx.user.id,
      }),
    ).rejects.toThrow(/must have distinct labels/);
    expect(await getOrgDefault(scope, INTEGRATION_ID)).toBeNull();

    // Control: distinct labels, same two-member shape, lands.
    const bOther = await seedSharedConnection(ctx.defaultSpaceId, "staging");
    const ok = await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [a, bOther],
      enforce: true,
      createdBy: ctx.user.id,
    });
    expect(ok.connection_ids).toEqual([a, bOther]);
  });

  it("deleting a member leaves its id in the set — an enforced default never shrinks", async () => {
    const a = await seedSharedConnection(ctx.defaultSpaceId, "staging");
    const b = await seedSharedConnection(ctx.defaultSpaceId, "prod");
    await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionIds: [a, b],
      enforce: true,
      createdBy: ctx.user.id,
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
      createdBy: ctx.user.id,
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
