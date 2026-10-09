// SPDX-License-Identifier: Apache-2.0

/**
 * `getCurrentScopesGranted` reads the `scopesGranted` of the single connection
 * being reconnected (keyed by `connectionId`, actor-filtered) so the kickoff
 * keeps re-consent a superset of that account's grant.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { integrationConnections } from "@appstrate/db/schema";
import { getCurrentScopesGranted } from "../../../src/services/integration-scope-resolver.ts";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const INTEGRATION_ID = "@official/gmail";

function gmailManifest(): Record<string, unknown> {
  return localIntegrationManifest({
    name: INTEGRATION_ID,
    displayName: "Gmail",
    auths: {
      primary: {
        type: "oauth2",
        authorizationEndpoint: "https://idp/a",
        tokenEndpoint: "https://idp/t",
        authorizedUris: ["https://api/*"],
        delivery: httpHeaderDelivery({
          name: "Authorization",
          prefix: "Bearer ",
          field: "access_token",
        }),
        scopeCatalog: [
          { value: "read", label: "Read" },
          { value: "send", label: "Send" },
          { value: "delete", label: "Delete" },
        ],
      },
    },
  }) as unknown as Record<string, unknown>;
}

describe("integration-scope-resolver", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "scope" });
    await seedPackage({
      id: INTEGRATION_ID,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: gmailManifest(),
    });
  });

  describe("getCurrentScopesGranted", () => {
    it("returns empty when the connection id doesn't exist", async () => {
      const granted = await getCurrentScopesGranted({
        scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
        integrationId: INTEGRATION_ID,
        authKey: "primary",
        actor: { type: "user", id: ctx.user.id },
        connectionId: "00000000-0000-0000-0000-000000000000",
      });
      expect(granted).toEqual([]);
    });

    it("returns the scopesGranted of the targeted connection only (not other accounts)", async () => {
      const [target] = await db
        .insert(integrationConnections)
        .values({
          integrationId: INTEGRATION_ID,
          authKey: "primary",
          accountId: "acct-1",
          label: "acct-1",
          spaceId: ctx.defaultSpaceId,
          userId: ctx.user.id,
          credentialsEncrypted: "x",
          scopesGranted: ["read"],
        })
        .returning({ id: integrationConnections.id });
      // A second account the actor owns must NOT leak into the target's set —
      // incremental consent is per-account, scoped to connectionId.
      await db.insert(integrationConnections).values({
        integrationId: INTEGRATION_ID,
        authKey: "primary",
        accountId: "acct-2",
        label: "acct-2",
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        credentialsEncrypted: "x",
        scopesGranted: ["read", "send"],
      });
      const granted = await getCurrentScopesGranted({
        scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
        integrationId: INTEGRATION_ID,
        authKey: "primary",
        actor: { type: "user", id: ctx.user.id },
        connectionId: target!.id,
      });
      expect(granted).toEqual(["read"]);
    });

    it("doesn't return another actor's connection scopes (ownership filter)", async () => {
      const other = await createTestUser();
      const [foreign] = await db
        .insert(integrationConnections)
        .values({
          integrationId: INTEGRATION_ID,
          authKey: "primary",
          accountId: "acct-foreign",
          label: "acct-foreign",
          spaceId: ctx.defaultSpaceId,
          userId: other.id,
          credentialsEncrypted: "x",
          scopesGranted: ["admin"],
        })
        .returning({ id: integrationConnections.id });
      const granted = await getCurrentScopesGranted({
        scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
        integrationId: INTEGRATION_ID,
        authKey: "primary",
        actor: { type: "user", id: ctx.user.id },
        connectionId: foreign!.id,
      });
      expect(granted).toEqual([]);
    });
  });
});
