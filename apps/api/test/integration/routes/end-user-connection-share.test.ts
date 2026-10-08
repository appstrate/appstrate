// SPDX-License-Identifier: Apache-2.0

/**
 * An end user's connection is never shared with the organization (#1775): the share door refuses
 * it. The database CHECK behind it is proven by `migration-script-0036-…`'s test.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedApiKey, seedEndUser, seedPackage } from "../../helpers/seed.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const INTEGRATION = "@euorg/svc";

describe("end-user connections are never shared", () => {
  let ctx: TestContext;
  let endUserId: string;
  let endUserHeaders: Record<string, string>;

  async function seedEndUserConnection(): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION,
        authKey: "primary",
        accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
        spaceId: ctx.defaultSpaceId,
        endUserId,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret" } }),
        scopesGranted: [],
        label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "euorg" });
    await seedPackage({
      id: INTEGRATION,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: localIntegrationManifest({
        name: INTEGRATION,
        serverName: "@euorg/svc-server",
        version: "1.0.0",
        auths: {
          primary: {
            type: "api_key",
            authorizedUris: ["https://api.example.com/**"],
            credentialFields: ["api_key"],
            delivery: httpHeaderDelivery({
              name: "Authorization",
              prefix: "Bearer ",
              field: "api_key",
            }),
          },
        },
        tools_policy: { search: {} },
      }),
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, INTEGRATION);

    const endUser = await seedEndUser({
      spaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      externalId: "ext-eu-share",
    });
    endUserId = endUser.id;
    const apiKey = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["integrations:connect"],
    });
    endUserHeaders = {
      Authorization: `Bearer ${apiKey.rawKey}`,
      "X-Space-Id": ctx.defaultSpaceId,
      "Appstrate-User": endUserId,
    };
  });

  it("409s an end user sharing their own connection, which stays private", async () => {
    const connectionId = await seedEndUserConnection();

    const res = await app.request(`/api/integrations/${INTEGRATION}/connections/${connectionId}`, {
      method: "PATCH",
      headers: { ...endUserHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ shared_with_org: true }),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "end_user_connection_not_shareable",
    );
    const [row] = await db
      .select({ shared: integrationConnections.sharedWithOrg })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId));
    expect(row?.shared).toBe(false);
  });
});
