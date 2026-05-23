// SPDX-License-Identifier: Apache-2.0

/**
 * connect.dependsOn — platform-side resolution of a connect.tool login's
 * dependency credentials.
 *
 * `resolveDependsOnAuths` resolves the SAME actor's accessible connection on
 * each declared dependency integration and produces a namespaced
 * `${depId}::${authKey}` auth + its rendered delivery plan, ready for the
 * sidecar to merge into the login runner's MITM source. Covers:
 *   - connected dependency with delivery.http → produces a namespaced auth.
 *   - not-connected dependency → skipped.
 *   - dependency whose auth has no delivery.http → skipped.
 *
 * Plus the spawn-resolver integration: a connectLogin integration declaring
 * `dependsOn: ["@dep/gmail"]` with a connected dep → spec carries
 * `dependsOnAuths`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { resolveDependsOnAuths } from "../../../src/services/integration-credentials-resolver.ts";
import { resolveIntegrationSpawns } from "../../../src/services/integration-spawn-resolver.ts";
import { LoginSecretStrategy } from "../../../src/services/connect/login-secret-strategy.ts";
import type { ConnectContext } from "../../../src/services/connect/strategy.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage } from "../../helpers/seed.ts";

const LOGIN = "@orga/craigslist-login";
const DEP_GMAIL = "@dep/gmail";
const DEP_NODELIVERY = "@dep/no-delivery";

/** Dependency integration with an http-injectable api_key auth (Gmail-like). */
function gmailManifest(): IntegrationManifest {
  return {
    manifestVersion: "1.0",
    type: "integration",
    name: DEP_GMAIL,
    version: "0.1.0",
    displayName: "Gmail Dep",
    description: "Dependency with delivery.http",
    server: { type: "node", entryPoint: "main.js" },
    auths: {
      primary: {
        type: "api_key",
        authorizedUris: ["https://gmail.googleapis.com/**"],
        credentials: {
          schema: { type: "object", properties: { apiKey: { type: "string" } } },
        },
        delivery: {
          http: { headerName: "Authorization", headerPrefix: "Bearer ", valueFrom: "apiKey" },
        },
      },
    },
    tools: { read_inbox: {} },
  } as unknown as IntegrationManifest;
}

/** Dependency integration whose auth has NO delivery.http (not injectable). */
function noDeliveryManifest(): IntegrationManifest {
  return {
    manifestVersion: "1.0",
    type: "integration",
    name: DEP_NODELIVERY,
    version: "0.1.0",
    displayName: "No-delivery Dep",
    description: "Dependency without delivery.http",
    server: { type: "node", entryPoint: "main.js" },
    auths: {
      primary: {
        type: "api_key",
        authorizedUris: ["https://nodelivery.example.com/**"],
        credentials: {
          schema: { type: "object", properties: { apiKey: { type: "string" } } },
        },
        // delivery.env only — nothing http-injectable.
        delivery: { env: { NODELIVERY_KEY: { from: "apiKey" } } },
      },
    },
    tools: {},
  } as unknown as IntegrationManifest;
}

/** Login integration declaring connect.tool + run-start + dependsOn. */
function loginManifest(dependsOn: string[]): IntegrationManifest {
  return {
    manifestVersion: "1.0",
    type: "integration",
    name: LOGIN,
    version: "0.1.0",
    displayName: "Craigslist Login",
    description: "Form-login that reads a magic-link via Gmail",
    server: { type: "node", entryPoint: "main.js" },
    auths: {
      session: {
        type: "custom",
        authorizedUris: ["https://craigslist.org/**"],
        credentials: {
          schema: { type: "object", properties: { email: { type: "string" } } },
        },
        delivery: { http: { headerName: "Cookie", valueFrom: "sessionId" } },
        connect: {
          tool: "login",
          runAt: "run-start",
          persistLoginSecret: true,
          produces: ["sessionId"],
          dependsOn,
        },
      },
    },
    tools: { browse: {}, login: {} },
  } as unknown as IntegrationManifest;
}

function agentManifest(): Record<string, unknown> {
  return {
    manifestVersion: "1.0",
    type: "agent",
    name: "@orga/agent",
    version: "0.1.0",
    dependencies: { integrations: { [LOGIN]: "^0.1.0" } },
    integrations: { [LOGIN]: { tools: ["browse"] } },
  };
}

describe("resolveDependsOnAuths", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  async function seedGmailConnection(token = "gmail-tok") {
    await seedPackage({
      id: DEP_GMAIL,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: gmailManifest(),
    });
    await seedInstalledPackage(ctx.defaultAppId, DEP_GMAIL);
    await db.insert(integrationConnections).values({
      integrationPackageId: DEP_GMAIL,
      authKey: "primary",
      accountId: "default",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentials({ apiKey: token }),
      identityClaims: {},
      scopesGranted: [],
      needsReconnection: false,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it("produces a namespaced auth + delivery plan for a connected dependency", async () => {
    await seedGmailConnection("gmail-tok");

    const out = await resolveDependsOnAuths(
      { applicationId: ctx.defaultAppId, actor: { type: "user", id: ctx.user.id } },
      [DEP_GMAIL],
    );

    expect(out).toHaveLength(1);
    const dep = out[0]!;
    expect(dep.authKey).toBe(`${DEP_GMAIL}::primary`);
    expect(dep.authType).toBe("api_key");
    expect(dep.authorizedUris).toEqual(["https://gmail.googleapis.com/**"]);
    expect(dep.fields.apiKey).toBe("gmail-tok");
    expect(dep.deliveryPlan).toEqual({
      headerName: "Authorization",
      headerPrefix: "Bearer ",
      value: "gmail-tok",
      allowServerOverride: false,
    });
  });

  it("skips a dependency that is not connected for the actor", async () => {
    // Seed the package but NO connection row.
    await seedPackage({
      id: DEP_GMAIL,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: gmailManifest(),
    });
    await seedInstalledPackage(ctx.defaultAppId, DEP_GMAIL);

    const out = await resolveDependsOnAuths(
      { applicationId: ctx.defaultAppId, actor: { type: "user", id: ctx.user.id } },
      [DEP_GMAIL],
    );
    expect(out).toHaveLength(0);
  });

  it("skips a dependency whose auth has no delivery.http", async () => {
    await seedPackage({
      id: DEP_NODELIVERY,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: noDeliveryManifest(),
    });
    await seedInstalledPackage(ctx.defaultAppId, DEP_NODELIVERY);
    await db.insert(integrationConnections).values({
      integrationPackageId: DEP_NODELIVERY,
      authKey: "primary",
      accountId: "default",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentials({ apiKey: "x" }),
      identityClaims: {},
      scopesGranted: [],
      needsReconnection: false,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const out = await resolveDependsOnAuths(
      { applicationId: ctx.defaultAppId, actor: { type: "user", id: ctx.user.id } },
      [DEP_NODELIVERY],
    );
    expect(out).toHaveLength(0);
  });
});

describe("resolveIntegrationSpawns — connect.dependsOn", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  async function seedDepGmail(token = "gmail-tok") {
    await seedPackage({
      id: DEP_GMAIL,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: gmailManifest(),
    });
    await seedInstalledPackage(ctx.defaultAppId, DEP_GMAIL);
    await db.insert(integrationConnections).values({
      integrationPackageId: DEP_GMAIL,
      authKey: "primary",
      accountId: "default",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentials({ apiKey: token }),
      identityClaims: {},
      scopesGranted: [],
      needsReconnection: false,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function seedLogin(dependsOn: string[]) {
    await seedPackage({
      id: LOGIN,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: loginManifest(dependsOn),
    });
    await seedInstalledPackage(ctx.defaultAppId, LOGIN);
    await new LoginSecretStrategy().complete(
      {
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        actor: { type: "user", id: ctx.user.id },
        integrationPackageId: LOGIN,
        authKey: "session",
      } as ConnectContext,
      { kind: "fields", credentials: { email: "me@example.com" } },
    );
  }

  it("attaches dependsOnAuths when the dependency is connected", async () => {
    await seedDepGmail("gmail-tok");
    await seedLogin([DEP_GMAIL]);

    const specs = await resolveIntegrationSpawns({
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });

    expect(specs).toHaveLength(1);
    const cl = specs[0]!.connectLogin;
    expect(cl).toBeDefined();
    expect(cl!.dependsOnAuths).toHaveLength(1);
    const dep = cl!.dependsOnAuths![0]!;
    expect(dep.authKey).toBe(`${DEP_GMAIL}::primary`);
    expect(dep.deliveryPlan.value).toBe("gmail-tok");
    expect(dep.authorizedUris).toEqual(["https://gmail.googleapis.com/**"]);
  });

  it("omits dependsOnAuths when the dependency is not connected", async () => {
    // Login declares dependsOn but the dep has no connection.
    await seedPackage({
      id: DEP_GMAIL,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: gmailManifest(),
    });
    await seedInstalledPackage(ctx.defaultAppId, DEP_GMAIL);
    await seedLogin([DEP_GMAIL]);

    const specs = await resolveIntegrationSpawns({
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });

    expect(specs).toHaveLength(1);
    expect(specs[0]!.connectLogin).toBeDefined();
    expect(specs[0]!.connectLogin!.dependsOnAuths).toBeUndefined();
  });
});
