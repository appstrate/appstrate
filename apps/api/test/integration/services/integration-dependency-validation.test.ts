// SPDX-License-Identifier: Apache-2.0

/**
 * Phase A.1/A.2 — run-kickoff integration dependency gating.
 *
 * Validates that `validateAgentIntegrations` and its non-throwing collector
 * surface the right structured errors for the agent editor's
 * MissingConnectionsModal (Phase C).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { integrationConnections } from "@appstrate/db/schema";
import {
  collectIntegrationDependencyErrors,
  validateAgentIntegrations,
} from "../../../src/services/dependency-validation.ts";
import { ApiError } from "../../../src/lib/errors.ts";

const INTEGRATION_ID = "@official/gmail";

function gmailManifest(): Record<string, unknown> {
  return {
    manifestVersion: "1.1",
    type: "integration",
    name: INTEGRATION_ID,
    version: "1.0.0",
    displayName: "Gmail",
    server: { type: "python", entryPoint: "./server.py" },
    auths: {
      primary: {
        type: "oauth2",
        authorizationUrl: "https://idp/a",
        tokenUrl: "https://idp/t",
        authorizedUris: ["https://api/*"],
        delivery: { http: {} },
        availableScopes: [
          { value: "read", label: "Read" },
          { value: "send", label: "Send" },
        ],
      },
    },
    tools: {
      list_messages: { requiredScopes: ["read"] },
      send_message: { requiredScopes: ["send"] },
    },
  };
}

function agentManifest(integrationDep: unknown): Record<string, unknown> {
  return {
    name: "@test/agent",
    version: "1.0.0",
    type: "agent",
    schemaVersion: "1.0",
    displayName: "Test Agent",
    dependencies: { integrations: { [INTEGRATION_ID]: integrationDep } },
  };
}

describe("collectIntegrationDependencyErrors", () => {
  let ctx: TestContext;
  let actor: { type: "user"; id: string };

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "deps" });
    actor = { type: "user", id: ctx.user.id };
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: gmailManifest(),
    });
  });

  it("returns no errors when the agent declares no integrations", async () => {
    const { fieldErrors, integrationErrors } = await collectIntegrationDependencyErrors(
      { name: "@test/agent", version: "1.0.0" },
      actor,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
    );
    expect(fieldErrors).toEqual([]);
    expect(integrationErrors).toEqual([]);
  });

  it("flags not_connected when the actor has no connection on the integration", async () => {
    const { fieldErrors, integrationErrors } = await collectIntegrationDependencyErrors(
      agentManifest({ version: "^1.0.0", tools: ["list_messages"] }),
      actor,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
    );
    expect(integrationErrors).toHaveLength(1);
    expect(integrationErrors[0]).toMatchObject({
      packageId: INTEGRATION_ID,
      authKey: null,
      reason: "not_connected",
    });
    expect(fieldErrors[0]?.field).toBe(`integrations.${INTEGRATION_ID}`);
    expect(fieldErrors[0]?.code).toBe("not_connected");
  });

  it("flags package_not_found when the integration package doesn't exist", async () => {
    const { integrationErrors } = await collectIntegrationDependencyErrors(
      {
        dependencies: { integrations: { "@nothing/here": "^1.0.0" } },
      } as Record<string, unknown>,
      actor,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
    );
    expect(integrationErrors).toHaveLength(1);
    expect(integrationErrors[0]?.reason).toBe("package_not_found");
  });

  it("flags needs_reconnection when the connection's needs_reconnection flag is set", async () => {
    await db.insert(integrationConnections).values({
      integrationPackageId: INTEGRATION_ID,
      authKey: "primary",
      accountId: "acct-1",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      credentialsEncrypted: "x",
      scopesGranted: ["read"],
      needsReconnection: true,
    });

    const { integrationErrors } = await collectIntegrationDependencyErrors(
      agentManifest({ version: "^1.0.0", tools: ["list_messages"] }),
      actor,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
    );
    expect(integrationErrors).toHaveLength(1);
    expect(integrationErrors[0]).toMatchObject({
      packageId: INTEGRATION_ID,
      authKey: "primary",
      reason: "needs_reconnection",
    });
  });

  it("flags insufficient_scopes with the missing scope list", async () => {
    await db.insert(integrationConnections).values({
      integrationPackageId: INTEGRATION_ID,
      authKey: "primary",
      accountId: "acct-1",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      credentialsEncrypted: "x",
      scopesGranted: ["read"],
    });

    const { integrationErrors } = await collectIntegrationDependencyErrors(
      agentManifest({ version: "^1.0.0", tools: ["list_messages", "send_message"] }),
      actor,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
    );
    expect(integrationErrors).toHaveLength(1);
    expect(integrationErrors[0]).toMatchObject({
      packageId: INTEGRATION_ID,
      authKey: "primary",
      reason: "insufficient_scopes",
      missingScopes: ["send"],
    });
    expect(integrationErrors[0]?.requiredScopes?.sort()).toEqual(["read", "send"]);
  });

  it("returns no errors when the actor has a sufficient connection", async () => {
    await db.insert(integrationConnections).values({
      integrationPackageId: INTEGRATION_ID,
      authKey: "primary",
      accountId: "acct-1",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      credentialsEncrypted: "x",
      scopesGranted: ["read", "send"],
    });

    const { integrationErrors } = await collectIntegrationDependencyErrors(
      agentManifest({ version: "^1.0.0", tools: ["list_messages", "send_message"] }),
      actor,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
    );
    expect(integrationErrors).toEqual([]);
  });

  it("unions scopes across multi-account connections (best-case)", async () => {
    // Account A has 'read', account B has 'send' — union covers both,
    // so an agent that needs both should NOT trigger insufficient_scopes
    // (incremental consent semantics, mirrors getCurrentGrantedScopes).
    await db.insert(integrationConnections).values([
      {
        integrationPackageId: INTEGRATION_ID,
        authKey: "primary",
        accountId: "acct-1",
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        credentialsEncrypted: "x",
        scopesGranted: ["read"],
      },
      {
        integrationPackageId: INTEGRATION_ID,
        authKey: "primary",
        accountId: "acct-2",
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        credentialsEncrypted: "x",
        scopesGranted: ["send"],
      },
    ]);

    const { integrationErrors } = await collectIntegrationDependencyErrors(
      agentManifest({ version: "^1.0.0", tools: ["list_messages", "send_message"] }),
      actor,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
    );
    expect(integrationErrors).toEqual([]);
  });

  it("scope check is skipped for api_key auths (PAT scopes opaque)", async () => {
    // Manifest with an api_key auth + tools tied to it. Granted scopes
    // are empty but we still pass — runtime upstream gates instead.
    const pat = "pat";
    await seedPackage({
      id: "@official/github",
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: {
        manifestVersion: "1.1",
        type: "integration",
        name: "@official/github",
        version: "1.0.0",
        displayName: "GitHub",
        server: { type: "http", url: "https://api.x/mcp" },
        auths: {
          [pat]: {
            type: "api_key",
            authorizedUris: ["https://api.x/*"],
            delivery: { http: { headerName: "Authorization", headerPrefix: "Bearer " } },
            credentials: {
              schema: { type: "object", properties: { apiKey: { type: "string" } } },
            },
          },
        },
        tools: {
          get_me: { requiredScopes: ["user:read"], requiredAuthKey: pat },
        },
      },
    });
    await db.insert(integrationConnections).values({
      integrationPackageId: "@official/github",
      authKey: pat,
      accountId: "u1",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      credentialsEncrypted: "x",
      scopesGranted: [],
    });

    const { integrationErrors } = await collectIntegrationDependencyErrors(
      {
        dependencies: {
          integrations: {
            "@official/github": { version: "^1.0.0", tools: ["get_me"] },
          },
        },
      } as Record<string, unknown>,
      actor,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
    );
    expect(integrationErrors).toEqual([]);
  });
});

describe("validateAgentIntegrations (throwing)", () => {
  let ctx: TestContext;
  let actor: { type: "user"; id: string };

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "deps-throw" });
    actor = { type: "user", id: ctx.user.id };
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: gmailManifest(),
    });
  });

  it("throws 412 with errors[] populated when the actor isn't connected", async () => {
    try {
      await validateAgentIntegrations(
        agentManifest({ version: "^1.0.0", tools: ["list_messages"] }),
        actor,
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(412);
      expect(apiErr.code).toBe("missing_integration_connection");
      expect(apiErr.fieldErrors).toHaveLength(1);
      expect(apiErr.fieldErrors?.[0]?.code).toBe("not_connected");
    }
  });

  it("attaches structured payload via Appstrate-Missing-Integrations header", async () => {
    try {
      await validateAgentIntegrations(
        agentManifest({ version: "^1.0.0", tools: ["list_messages"] }),
        actor,
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      const apiErr = err as ApiError;
      const headerB64 = apiErr.headers?.["Appstrate-Missing-Integrations"];
      expect(headerB64).toBeTruthy();
      const decoded = JSON.parse(Buffer.from(headerB64!, "base64").toString());
      expect(Array.isArray(decoded)).toBe(true);
      expect(decoded[0]).toMatchObject({
        packageId: INTEGRATION_ID,
        reason: "not_connected",
      });
    }
  });

  it("does not throw when the agent has no integration deps", async () => {
    await validateAgentIntegrations({ name: "@test/agent" }, actor, {
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
    });
  });

  it("scopes connections to the actor — another user's connection doesn't satisfy", async () => {
    // Seed a second user with the connection.
    const other = await createTestContext({ orgSlug: "deps-throw-other" });
    await db.insert(integrationConnections).values({
      integrationPackageId: INTEGRATION_ID,
      authKey: "primary",
      accountId: "acct-1",
      applicationId: ctx.defaultAppId,
      userId: other.user.id,
      credentialsEncrypted: "x",
      scopesGranted: ["read", "send"],
    });

    try {
      await validateAgentIntegrations(
        agentManifest({ version: "^1.0.0", tools: ["list_messages"] }),
        actor,
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ApiError).status).toBe(412);
    }
  });
});
