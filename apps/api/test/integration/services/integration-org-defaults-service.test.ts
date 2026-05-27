// SPDX-License-Identifier: Apache-2.0

/**
 * E-extra — integration org-defaults service.
 *
 * Org-wide default connection per (application, integration): the cross-agent
 * governance baseline. CRUD round-trip + org isolation.
 *
 * `upsertOrgDefault` delegates target validation to `validatePinTarget` with
 * `requireShared: true`, so the seeded connection must be `sharedWithOrg=true`,
 * belong to the application, and reference the integration.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import {
  upsertOrgDefault,
  getOrgDefault,
  listOrgDefaultsForResolver,
  deleteOrgDefault,
} from "../../../src/services/integration-org-defaults-service.ts";
import type { AppScope } from "../../../src/lib/scope.ts";

const INTEGRATION_ID = "@official/gmail";

function integrationManifest(): Record<string, unknown> {
  return {
    schema_version: "2.0",
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
  let scope: AppScope;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orgdef" });
    scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: integrationManifest(),
    });
  });

  /** Seed a sharedWithOrg connection (the only valid org-default target). */
  async function seedSharedConnection(applicationId = ctx.defaultAppId): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION_ID,
        authKey: "primary",
        accountId: "acct-shared",
        applicationId,
        userId: ctx.user.id,
        credentialsEncrypted: encryptCredentials({ api_key: "k" }),
        scopesGranted: [],
        sharedWithOrg: true,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  it("round-trips upsert → get → resolver-shape → delete (idempotent)", async () => {
    const connId = await seedSharedConnection();

    // upsert
    const created = await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionId: connId,
      enforce: true,
      createdBy: ctx.user.id,
    });
    expect(created.connection_id).toBe(connId);
    expect(created.enforce).toBe(true);
    expect(created.auth_key).toBe("primary");

    // get
    const fetched = await getOrgDefault(scope, INTEGRATION_ID);
    expect(fetched).not.toBeNull();
    expect(fetched!.connection_id).toBe(connId);
    expect(fetched!.enforce).toBe(true);
    expect(fetched!.auth_key).toBe("primary");

    // listOrgDefaultsForResolver shape
    const resolverMap = await listOrgDefaultsForResolver(ctx.defaultAppId);
    expect(resolverMap[INTEGRATION_ID]).toEqual({ connectionId: connId, enforce: true });

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
      connectionId: connA,
      enforce: false,
      createdBy: ctx.user.id,
    });
    const replaced = await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionId: connB,
      enforce: true,
      createdBy: ctx.user.id,
    });
    expect(replaced.connection_id).toBe(connB);
    expect(replaced.enforce).toBe(true);

    const fetched = await getOrgDefault(scope, INTEGRATION_ID);
    expect(fetched!.connection_id).toBe(connB);
    expect(fetched!.enforce).toBe(true);
  });

  it("getOrgDefault returns null when no default is set", async () => {
    expect(await getOrgDefault(scope, INTEGRATION_ID)).toBeNull();
    expect(await listOrgDefaultsForResolver(ctx.defaultAppId)).toEqual({});
  });

  it("org isolation: one org cannot read another org's default", async () => {
    const connId = await seedSharedConnection();
    await upsertOrgDefault(scope, INTEGRATION_ID, {
      connectionId: connId,
      enforce: true,
      createdBy: ctx.user.id,
    });

    // A second org with its own application — must not see org 1's default.
    const otherCtx = await createTestContext({ orgSlug: "orgdef-other" });
    const otherScope: AppScope = {
      orgId: otherCtx.orgId,
      applicationId: otherCtx.defaultAppId,
    };
    expect(await getOrgDefault(otherScope, INTEGRATION_ID)).toBeNull();
    expect(await listOrgDefaultsForResolver(otherCtx.defaultAppId)).toEqual({});
  });
});
