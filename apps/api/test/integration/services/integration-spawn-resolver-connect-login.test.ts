// SPDX-License-Identifier: Apache-2.0

/**
 * P2 — spawn resolver for `connect.tool` + `runAt: "run-start"` integrations.
 *
 * A connection holding a persisted login secret yields a spec with
 * `connectLogin` populated (login tool excluded from the allowlist, inputs
 * decrypted, MITM placeholder so the sidecar creates the listener+source).
 * A connection with no persisted secret yields no spawn for that integration.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import { LoginSecretStrategy } from "../../../src/services/connect/login-secret-strategy.ts";
import type { ConnectContext } from "../../../src/services/connect/strategy.ts";
import { resolveIntegrationSpawns } from "../../../src/services/integration-spawn-resolver.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage } from "../../helpers/seed.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";

const INTEG = "@orga/wajax-spawn";

function runStartManifest(name = INTEG): IntegrationManifest {
  return {
    manifestVersion: "1.0",
    type: "integration",
    name,
    version: "0.1.0",
    displayName: "OrgaBusiness",
    description: "Form-login integration (run-start)",
    server: { type: "node", entryPoint: "main.js" },
    auths: {
      session: {
        type: "custom",
        authorizedUris: ["https://saas.example.com/**"],
        credentials: {
          schema: {
            type: "object",
            properties: { identifiant: { type: "string" }, mot_de_passe: { type: "string" } },
          },
        },
        delivery: { http: { headerName: "Cookie", valueFrom: "JSESSIONID" } },
        connect: {
          tool: "login",
          runAt: "run-start",
          persistLoginSecret: true,
          produces: ["JSESSIONID"],
        },
      },
    },
    // The agent may pick `fetch_invoices`; the login tool itself must never
    // surface to the agent regardless of selection.
    tools: { fetch_invoices: {}, login: {} },
  } as unknown as IntegrationManifest;
}

/**
 * Agent manifest selecting both a real tool AND the login tool (to prove the
 * resolver strips `login` from the allowlist even when an author lists it).
 */
function agentManifest(): Record<string, unknown> {
  return {
    manifestVersion: "1.0",
    type: "agent",
    name: "@orga/agent",
    version: "0.1.0",
    dependencies: { integrations: { [INTEG]: "^0.1.0" } },
    integrations: { [INTEG]: { tools: ["fetch_invoices", "login"] } },
  };
}

describe("resolveIntegrationSpawns — connect.tool run-start", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: runStartManifest(),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
  });

  function connectCtx(): ConnectContext {
    return {
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      actor: { type: "user", id: ctx.user.id },
      integrationPackageId: INTEG,
      authKey: "session",
    } as ConnectContext;
  }

  it("populates connectLogin (inputs decrypted, login tool excluded) when a secret is stored", async () => {
    await new LoginSecretStrategy().complete(connectCtx(), {
      kind: "fields",
      credentials: { identifiant: "user1", mot_de_passe: "s3cr3t" },
    });

    const specs = await resolveIntegrationSpawns({
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });

    expect(specs.length).toBe(1);
    const spec = specs[0]!;
    expect(spec.integrationId).toBe(INTEG);

    // connectLogin carries the decrypted login secret + delivery render config.
    expect(spec.connectLogin).toBeDefined();
    expect(spec.connectLogin!.toolName).toBe("login");
    expect(spec.connectLogin!.authKey).toBe("session");
    expect(spec.connectLogin!.authType).toBe("custom");
    expect(spec.connectLogin!.produces).toEqual(["JSESSIONID"]);
    expect(spec.connectLogin!.authorizedUris).toEqual(["https://saas.example.com/**"]);
    expect(spec.connectLogin!.deliveryHttp).toEqual({
      headerName: "Cookie",
      valueFrom: "JSESSIONID",
    });
    expect(spec.connectLogin!.inputs).toEqual({ identifiant: "user1", mot_de_passe: "s3cr3t" });
    // The manifest omitted `reauthOn` → field absent (sidecar defaults to [401]).
    expect(spec.connectLogin!.reauthOn).toBeUndefined();

    // The login tool is NEVER exposed to the agent, even though the author
    // listed it in the selection.
    expect(spec.toolAllowlist).toEqual(["fetch_invoices"]);

    // A MITM placeholder exists so the sidecar creates the listener + source;
    // the value is empty at rest (the real session is minted at boot).
    expect(spec.httpDeliveryAuths).toBeDefined();
    expect(spec.httpDeliveryAuths!.session).toBeDefined();
    expect(spec.httpDeliveryAuths!.session!.value).toBe("");
    expect(spec.httpDeliveryAuths!.session!.authorizedUris).toEqual([
      "https://saas.example.com/**",
    ]);

    // No env delivery on this auth.
    expect(spec.spawnEnv).toEqual({});
  });

  it("yields no spawn when the connection has no persisted login secret", async () => {
    // A connect.tool run-start row with an EMPTY inputs plane (e.g. a stale
    // row, or one created out-of-band) is treated as not-connected.
    await db.insert(integrationConnections).values({
      integrationPackageId: INTEG,
      authKey: "session",
      accountId: "default",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      endUserId: null,
      // Flat v1 blob = no inputs plane → decryptCredentialInputsToStringMap → {}
      credentialsEncrypted: encryptCredentials({}),
      identityClaims: {},
      scopesGranted: [],
      needsReconnection: false,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const specs = await resolveIntegrationSpawns({
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });

    expect(specs.length).toBe(0);
  });

  it("copies manifest auth.connect.reauthOn into connectLogin", async () => {
    // Re-seed the integration with a manifest that declares reauthOn.
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
    const manifest = runStartManifest();
    const sessionAuth = manifest.auths!.session!;
    (sessionAuth.connect as { reauthOn?: number[] }).reauthOn = [401, 419];
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest,
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await new LoginSecretStrategy().complete(connectCtx(), {
      kind: "fields",
      credentials: { identifiant: "user1", mot_de_passe: "s3cr3t" },
    });

    const specs = await resolveIntegrationSpawns({
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });

    expect(specs.length).toBe(1);
    expect(specs[0]!.connectLogin!.reauthOn).toEqual([401, 419]);
  });
});
