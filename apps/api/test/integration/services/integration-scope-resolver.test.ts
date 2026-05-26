// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 2 — integration scope-resolver:
 *
 *   - `computeRequiredScopes` walks installed agents, infers scopes from
 *     tool selections + explicit agent scopes, unions everything. Consumed
 *     at refresh time to detect IdP-side scope shrink (not by the kickoff).
 *   - `getCurrentScopesGranted` reads the `scopesGranted` of the single
 *     connection being reconnected (keyed by `connectionId`, actor-filtered)
 *     so the kickoff keeps re-consent a superset of that account's grant.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { integrationConnections } from "@appstrate/db/schema";
import {
  computeRequiredScopes,
  getCurrentScopesGranted,
} from "../../../src/services/integration-scope-resolver.ts";
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
    tools_policy: {
      list_messages: { required_scopes: ["read"] },
      get_message: { required_scopes: ["read"] },
      send_message: { required_scopes: ["send"] },
      delete_message: { required_scopes: ["delete"] },
    },
  }) as unknown as Record<string, unknown>;
}

function agentManifest(
  name: string,
  selection: { version: string; tools?: string[]; scopes?: string[] },
): Record<string, unknown> {
  const { version, tools, scopes } = selection;
  const m: Record<string, unknown> = {
    name,
    version: "1.0.0",
    type: "agent",
    schema_version: "2.0",
    display_name: name,
    dependencies: { integrations: { [INTEGRATION_ID]: version } },
  };
  if (tools !== undefined || scopes !== undefined) {
    m.integrations = {
      [INTEGRATION_ID]: {
        ...(tools !== undefined ? { tools } : {}),
        ...(scopes !== undefined ? { scopes } : {}),
      },
    };
  }
  return m;
}

describe("integration-scope-resolver", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "scope" });
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: gmailManifest(),
    });
  });

  describe("computeRequiredScopes", () => {
    it("returns empty when no agent depends on the integration", async () => {
      const out = await computeRequiredScopes({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        integrationPackageId: INTEGRATION_ID,
        authKey: "primary",
      });
      expect(out.required).toEqual([]);
    });

    it("returns empty when the integration package itself isn't visible", async () => {
      const out = await computeRequiredScopes({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        integrationPackageId: "@nothing/here",
        authKey: "primary",
      });
      expect(out.required).toEqual([]);
    });

    it("infers required scopes from a single agent's tool selection", async () => {
      await seedPackage({
        id: "@scope/agent-reader",
        orgId: ctx.orgId,
        type: "agent",
        draftManifest: agentManifest("@scope/agent-reader", {
          version: "^1.0.0",
          tools: ["list_messages", "get_message"],
        }),
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@scope/agent-reader",
      );

      const out = await computeRequiredScopes({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        integrationPackageId: INTEGRATION_ID,
        authKey: "primary",
      });
      expect(out.required).toEqual(["read"]);
    });

    it("unions scopes across multiple installed agents (dedupes overlap)", async () => {
      // Reader uses gmail.readonly. Sender uses gmail.send. Union = both.
      for (const [id, tools] of [
        ["@scope/reader", ["list_messages"]],
        ["@scope/sender", ["send_message"]],
        ["@scope/another-reader", ["get_message"]], // overlaps reader
      ] as const) {
        await seedPackage({
          id,
          orgId: ctx.orgId,
          type: "agent",
          draftManifest: agentManifest(id, { version: "^1.0.0", tools: [...tools] }),
        });
        await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, id);
      }
      const out = await computeRequiredScopes({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        integrationPackageId: INTEGRATION_ID,
        authKey: "primary",
      });
      expect(out.required.sort()).toEqual(["read", "send"]);
    });

    it("agent declaring the dep without a selection contributes zero scopes (least-privilege)", async () => {
      await seedPackage({
        id: "@scope/agent-noselection",
        orgId: ctx.orgId,
        type: "agent",
        draftManifest: agentManifest("@scope/agent-noselection", { version: "^1.0.0" }),
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@scope/agent-noselection",
      );

      const out = await computeRequiredScopes({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        integrationPackageId: INTEGRATION_ID,
        authKey: "primary",
      });
      expect(out.required).toEqual([]);
    });

    it("includes explicit agent.scopes[] in the union", async () => {
      await seedPackage({
        id: "@scope/agent-manual",
        orgId: ctx.orgId,
        type: "agent",
        draftManifest: agentManifest("@scope/agent-manual", {
          version: "^1.0.0",
          tools: ["list_messages"],
          scopes: ["delete"],
        }),
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@scope/agent-manual",
      );

      const out = await computeRequiredScopes({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        integrationPackageId: INTEGRATION_ID,
        authKey: "primary",
      });
      expect(out.required.sort()).toEqual(["delete", "read"]);
    });

    it("agent that declared rich form with empty tools[] contributes only its explicit scopes", async () => {
      await seedPackage({
        id: "@scope/agent-empty",
        orgId: ctx.orgId,
        type: "agent",
        draftManifest: agentManifest("@scope/agent-empty", {
          version: "^1.0.0",
          tools: [],
          scopes: ["read"],
        }),
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@scope/agent-empty",
      );

      const out = await computeRequiredScopes({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        integrationPackageId: INTEGRATION_ID,
        authKey: "primary",
      });
      expect(out.required).toEqual(["read"]);
    });

    it("skips agents whose dep doesn't reference this integration", async () => {
      await seedPackage({
        id: "@scope/agent-other",
        orgId: ctx.orgId,
        type: "agent",
        draftManifest: {
          name: "@scope/agent-other",
          version: "1.0.0",
          type: "agent",
          schema_version: "2.0",
          display_name: "Other",
          dependencies: { integrations: { "@some/other": "^1.0.0" } },
        },
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@scope/agent-other",
      );

      const out = await computeRequiredScopes({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        integrationPackageId: INTEGRATION_ID,
        authKey: "primary",
      });
      expect(out.required).toEqual([]);
    });
  });

  describe("getCurrentScopesGranted", () => {
    it("returns empty when the connection id doesn't exist", async () => {
      const granted = await getCurrentScopesGranted({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        integrationPackageId: INTEGRATION_ID,
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
          integrationPackageId: INTEGRATION_ID,
          authKey: "primary",
          accountId: "acct-1",
          applicationId: ctx.defaultAppId,
          userId: ctx.user.id,
          credentialsEncrypted: "x",
          scopesGranted: ["read"],
        })
        .returning({ id: integrationConnections.id });
      // A second account the actor owns must NOT leak into the target's set —
      // incremental consent is per-account, scoped to connectionId.
      await db.insert(integrationConnections).values({
        integrationPackageId: INTEGRATION_ID,
        authKey: "primary",
        accountId: "acct-2",
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        credentialsEncrypted: "x",
        scopesGranted: ["read", "send"],
      });
      const granted = await getCurrentScopesGranted({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        integrationPackageId: INTEGRATION_ID,
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
          integrationPackageId: INTEGRATION_ID,
          authKey: "primary",
          accountId: "acct-foreign",
          applicationId: ctx.defaultAppId,
          userId: other.id,
          credentialsEncrypted: "x",
          scopesGranted: ["admin"],
        })
        .returning({ id: integrationConnections.id });
      const granted = await getCurrentScopesGranted({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        integrationPackageId: INTEGRATION_ID,
        authKey: "primary",
        actor: { type: "user", id: ctx.user.id },
        connectionId: foreign!.id,
      });
      expect(granted).toEqual([]);
    });
  });
});
