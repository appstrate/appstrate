// SPDX-License-Identifier: Apache-2.0

/**
 * Run-kickoff integration dependency gating.
 *
 * Validates that `collectIntegrationDependencyErrors` surfaces the right
 * structured errors for the agent editor's MissingConnectionsModal.
 * The throwing wrapper that maps these errors to a 412 ApiError lives in
 * `validateAgentReadiness` — covered by its own tests.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { integrationConnections } from "@appstrate/db/schema";
import { collectIntegrationDependencyErrors } from "../../../src/services/dependency-validation.ts";
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

function agentManifest(selection: {
  version: string;
  tools?: string[];
  scopes?: string[];
}): Record<string, unknown> {
  const { version, tools, scopes } = selection;
  const m: Record<string, unknown> = {
    name: "@test/agent",
    version: "1.0.0",
    type: "agent",
    schemaVersion: "1.0",
    displayName: "Test Agent",
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

  it("treats implied scopes as granted (parent grant covers narrower children)", async () => {
    // Override the integration with a hierarchy: `write` implies `read`,
    // `admin` implies `write` (transitively `read`). An agent that needs
    // {read, send} must NOT be flagged insufficient_scopes when the
    // connection was granted just {admin, send} — `admin` covers `read`.
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "deps" });
    actor = { type: "user", id: ctx.user.id };
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: {
        ...gmailManifest(),
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
              { value: "write", label: "Write", implies: ["read"] },
              { value: "admin", label: "Admin", implies: ["write", "read"] },
            ],
          },
        },
      },
    });
    await db.insert(integrationConnections).values({
      integrationPackageId: INTEGRATION_ID,
      authKey: "primary",
      accountId: "acct-1",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      credentialsEncrypted: "x",
      scopesGranted: ["admin", "send"],
    });

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

describe("collectIntegrationDependencyErrors (additional cases)", () => {
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

  it("returns a not_connected entry when the actor isn't connected", async () => {
    const { fieldErrors } = await collectIntegrationDependencyErrors(
      agentManifest({ version: "^1.0.0", tools: ["list_messages"] }),
      actor,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
    );
    expect(fieldErrors).toHaveLength(1);
    expect(fieldErrors[0]?.code).toBe("not_connected");
  });

  it("returns no errors when the agent has no integration deps", async () => {
    const { fieldErrors } = await collectIntegrationDependencyErrors(
      { name: "@test/agent" },
      actor,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
    );
    expect(fieldErrors).toEqual([]);
  });

  it("scopes connections to the actor — another user's connection doesn't satisfy", async () => {
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

    const { fieldErrors } = await collectIntegrationDependencyErrors(
      agentManifest({ version: "^1.0.0", tools: ["list_messages"] }),
      actor,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
    );
    expect(fieldErrors).toHaveLength(1);
    expect(fieldErrors[0]?.code).toBe("not_connected");
  });
});

describe("saveIntegrationConnection — single-auth invariant", () => {
  let ctx: TestContext;
  let actor: { type: "user"; id: string };

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "single-auth" });
    actor = { type: "user", id: ctx.user.id };
  });

  it("refuses a second connection on a different auth for the same actor/integration", async () => {
    // Multi-auth integration declaring both oauth + pat (mirrors GitHub MCP).
    const dualAuthId = "@official/dual";
    await seedPackage({
      id: dualAuthId,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: {
        manifestVersion: "1.1",
        type: "integration",
        name: dualAuthId,
        version: "1.0.0",
        displayName: "Dual",
        server: { type: "http", url: "https://api.x/mcp" },
        auths: {
          oauth: {
            type: "oauth2",
            authorizationUrl: "https://idp/a",
            tokenUrl: "https://idp/t",
            authorizedUris: ["https://api.x/*"],
            delivery: { http: {} },
          },
          pat: {
            type: "api_key",
            authorizedUris: ["https://api.x/*"],
            delivery: { http: { headerName: "Authorization", headerPrefix: "Bearer " } },
            credentials: { schema: { type: "object", properties: { apiKey: { type: "string" } } } },
          },
        },
      },
    });

    const { saveIntegrationConnection } =
      await import("../../../src/services/integration-connections.ts");

    // First connection on `oauth` succeeds.
    await saveIntegrationConnection(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      {
        packageId: dualAuthId,
        authKey: "oauth",
        accountId: "u1",
        credentials: { access_token: "tok" },
        actor,
      },
    );

    // Second connection on `pat` for the same actor must throw 409.
    let caught: unknown;
    try {
      await saveIntegrationConnection(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        {
          packageId: dualAuthId,
          authKey: "pat",
          accountId: "u1",
          credentials: { apiKey: "secret" },
          actor,
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(409);
    expect((caught as ApiError).code).toBe("integration_other_auth_connected");
  });
});
