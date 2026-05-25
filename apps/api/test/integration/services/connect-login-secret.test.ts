// SPDX-License-Identifier: Apache-2.0

/**
 * P2 — `LoginSecretStrategy.complete` store-the-secret acquisition.
 *
 * For `custom` + `connect.tool` + `runAt: "run-start"` auths, dashboard
 * connect stores ONLY the login secret in the v2 envelope's NON-injectable
 * `inputs` plane. The injectable `outputs` plane stays empty — the session is
 * minted later, at each agent run, by the sidecar's connect-login primitive.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import {
  decryptCredentialsToStringMap,
  decryptCredentialInputsToStringMap,
} from "@appstrate/connect";
import { LoginSecretStrategy } from "../../../src/services/connect/login-secret-strategy.ts";
import type { ConnectContext } from "../../../src/services/connect/strategy.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
  connectToolBlock,
} from "../../helpers/integration-manifests.ts";

function runStartManifest(name: string): IntegrationManifest {
  return localIntegrationManifest({
    name,
    version: "0.1.0",
    displayName: "OrgaBusiness",
    description: "Form-login integration (run-start)",
    auths: {
      session: {
        type: "custom",
        authorizedUris: ["https://saas.example.com/**"],
        credentialFields: ["identifiant", "mot_de_passe"],
        delivery: httpHeaderDelivery({ name: "Cookie", field: "JSESSIONID" }),
        connect: connectToolBlock({
          tool: "login",
          runAt: "run-start",
          persistLoginSecret: true,
          produces: ["JSESSIONID"],
        }),
      },
    },
  });
}

describe("LoginSecretStrategy.complete — store the secret, session pending", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  function connectCtx(packageId: string): ConnectContext {
    return {
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      actor: { type: "user", id: ctx.user.id },
      integrationPackageId: packageId,
      authKey: "session",
    } as ConnectContext;
  }

  it("persists the login secret as a NON-injectable input with EMPTY injectable outputs", async () => {
    const pkg = await seedPackage({
      id: "@orga/wajax-rs",
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: runStartManifest("@orga/wajax-rs"),
    });
    const strategy = new LoginSecretStrategy();

    const summary = await strategy.complete(connectCtx(pkg.id), {
      kind: "fields",
      credentials: { identifiant: "user1", mot_de_passe: "s3cr3t" },
    });

    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, summary.id));
    expect(row).toBeDefined();

    // No session yet — the injectable outputs plane is empty.
    expect(decryptCredentialsToStringMap(row!.credentialsEncrypted)).toEqual({});

    // The login secret survives only in the NON-injectable inputs plane.
    expect(decryptCredentialInputsToStringMap(row!.credentialsEncrypted)).toEqual({
      identifiant: "user1",
      mot_de_passe: "s3cr3t",
    });

    // Connection metadata: default account, not flagged for reconnection.
    expect(summary.accountId).toBe("default");
    expect(summary.needsReconnection).toBe(false);
    expect(summary.expiresAt).toBeNull();
    expect(summary.scopesGranted).toEqual([]);
  });

  it("rejects an empty credentials payload", async () => {
    const pkg = await seedPackage({
      id: "@orga/wajax-rs2",
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: runStartManifest("@orga/wajax-rs2"),
    });
    await expect(
      new LoginSecretStrategy().complete(connectCtx(pkg.id), { kind: "fields", credentials: {} }),
    ).rejects.toThrow(/cannot be empty/);
  });

  it("rejects a wrong-kind input before any DB write", async () => {
    await expect(
      new LoginSecretStrategy().complete(
        {
          scope: { orgId: "o", applicationId: "a" },
          actor: { type: "user", id: "u" },
          integrationPackageId: "@x/y",
          authKey: "session",
        } as ConnectContext,
        { kind: "oauth2-result", result: {} as never },
      ),
    ).rejects.toThrow(/unexpected input kind/);
  });
});
