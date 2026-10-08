// SPDX-License-Identifier: Apache-2.0

/**
 * An end user's connection is never shared with the organization (#1775), so it never enters an
 * admin pin or an org default, and the SQL cascade of `DELETE /api/end-users/{id}` leaves no set
 * naming a deleted connection.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedApiKey, seedEndUser, seedPackage } from "../../helpers/seed.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import {
  integrationConnections,
  integrationOrgDefaults,
  integrationPins,
} from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

const AGENT = "@euorg/agent";
const INTEGRATION = "@euorg/svc";

describe("end-user connections are never shared", () => {
  let ctx: TestContext;
  let endUserId: string;
  let endUserHeaders: Record<string, string>;

  async function seedConnection(
    owner: { userId: string } | { endUserId: string },
    shared: boolean,
  ): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION,
        authKey: "primary",
        accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
        spaceId: ctx.defaultSpaceId,
        userId: "userId" in owner ? owner.userId : null,
        endUserId: "endUserId" in owner ? owner.endUserId : null,
        credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "secret" } }),
        scopesGranted: [],
        sharedWithOrg: shared,
        label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  function patchShared(connectionId: string, headers: Record<string, string>) {
    return app.request(`/api/integrations/${INTEGRATION}/connections/${connectionId}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ shared_with_org: true }),
    });
  }

  function putAdminPin(connectionIds: string[]) {
    return app.request(`/api/integrations/${INTEGRATION}/pins/${AGENT}`, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ connection_ids: connectionIds }),
    });
  }

  function putOrgDefault(connectionIds: string[]) {
    return app.request(`/api/integrations/${INTEGRATION}/default`, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ connection_ids: connectionIds, enforce: true }),
    });
  }

  async function isShared(connectionId: string): Promise<boolean | undefined> {
    const [row] = await db
      .select({ shared: integrationConnections.sharedWithOrg })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId));
    return row?.shared;
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "euorg" });
    await seedAgent({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: AGENT,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.2",
        display_name: "End-user share agent",
        dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
        integrations_configuration: { [INTEGRATION]: { tools: ["search"] } },
      },
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
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
    const connectionId = await seedConnection({ endUserId }, false);

    const res = await patchShared(connectionId, endUserHeaders);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "end_user_connection_not_shareable",
    );
    expect(await isShared(connectionId)).toBe(false);
  });

  it("leaves every admin pin and org default naming live connections once the end user is deleted", async () => {
    const endUserConnection = await seedConnection({ endUserId }, false);
    const memberConnection = await seedConnection({ userId: ctx.user.id }, true);

    expect((await patchShared(endUserConnection, endUserHeaders)).status).toBe(409);
    expect((await putAdminPin([memberConnection])).status).toBe(200);
    expect((await putOrgDefault([memberConnection])).status).toBe(200);

    const del = await app.request(`/api/end-users/${endUserId}`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(del.status).toBe(204);

    const live = new Set(
      (await db.select({ id: integrationConnections.id }).from(integrationConnections)).map(
        (r) => r.id,
      ),
    );
    expect(live.has(endUserConnection)).toBe(false);
    const named = [
      ...(await db.select({ ids: integrationPins.connectionIds }).from(integrationPins)),
      ...(await db
        .select({ ids: integrationOrgDefaults.connectionIds })
        .from(integrationOrgDefaults)),
    ].flatMap((r) => r.ids);
    expect(named).toEqual([memberConnection, memberConnection]);
  });
});
