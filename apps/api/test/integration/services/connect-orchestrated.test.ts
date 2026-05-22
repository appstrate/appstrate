// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 4 security gate (spec §4.6): an OrchestratedStrategy connection with
 * `persistLoginSecret` stores the bootstrap secret in the v2 envelope's
 * NON-injectable `inputs` plane — the injection path (`decryptCredentialsToStringMap`)
 * can never read it, only the connect-runner's dedicated `inputs` reader can.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import {
  decryptCredentialsToStringMap,
  decryptCredentialInputsToStringMap,
} from "@appstrate/connect";
import {
  OrchestratedStrategy,
  type ConnectToolExecutor,
} from "../../../src/services/connect/orchestrated-strategy.ts";
import type { ConnectContext } from "../../../src/services/connect/strategy.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";

function orchestratedManifest(name: string, persistLoginSecret: boolean): IntegrationManifest {
  return {
    manifestVersion: "1.0",
    type: "integration",
    name,
    version: "0.1.0",
    displayName: "OrgaBusiness",
    description: "Form-login integration",
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
          persistLoginSecret,
          produces: ["JSESSIONID"],
        },
      },
    },
  } as IntegrationManifest;
}

// Fake connect-run substrate: returns a captured session.
const fakeExecutor: ConnectToolExecutor = {
  run: async () => ({ outputs: { JSESSIONID: "sess-abc" }, expiresAt: null }),
};

describe("OrchestratedStrategy.complete — persistLoginSecret gating (§4.6)", () => {
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

  it("stores outputs as injectables and the login secret as a NON-injectable input", async () => {
    const pkg = await seedPackage({
      id: "@orga/wajax",
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: orchestratedManifest("@orga/wajax", true),
    });
    const strategy = new OrchestratedStrategy(fakeExecutor);

    const summary = await strategy.complete(connectCtx(pkg.id), {
      kind: "fields",
      credentials: { identifiant: "user1", mot_de_passe: "s3cr3t" },
    });

    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, summary.id));
    expect(row).toBeDefined();

    // The injection path sees ONLY the captured session output.
    const injectable = decryptCredentialsToStringMap(row!.credentialsEncrypted);
    expect(injectable).toEqual({ JSESSIONID: "sess-abc" });
    expect(JSON.stringify(injectable)).not.toContain("s3cr3t");

    // The login secret survives — but only via the connect-runner's input reader.
    const inputs = decryptCredentialInputsToStringMap(row!.credentialsEncrypted);
    expect(inputs).toEqual({ identifiant: "user1", mot_de_passe: "s3cr3t" });
  });

  it("does not persist any input plane when persistLoginSecret is off", async () => {
    const pkg = await seedPackage({
      id: "@orga/wajax2",
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: orchestratedManifest("@orga/wajax2", false),
    });
    const strategy = new OrchestratedStrategy(fakeExecutor);

    const summary = await strategy.complete(connectCtx(pkg.id), {
      kind: "fields",
      credentials: { identifiant: "user1", mot_de_passe: "s3cr3t" },
    });

    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, summary.id));
    expect(decryptCredentialsToStringMap(row!.credentialsEncrypted)).toEqual({
      JSESSIONID: "sess-abc",
    });
    // Flat v1 blob → no inputs plane at all.
    expect(decryptCredentialInputsToStringMap(row!.credentialsEncrypted)).toEqual({});
  });

  it("hands the executor field NAMES only — never the secret value", async () => {
    const pkg = await seedPackage({
      id: "@orga/wajax3",
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: orchestratedManifest("@orga/wajax3", true),
    });
    let captured: Record<string, unknown> = {};
    const executor: ConnectToolExecutor = {
      run: async (exec) => {
        captured = { inputFields: exec.inputFields };
        return { outputs: { JSESSIONID: "s" }, expiresAt: null };
      },
    };
    await new OrchestratedStrategy(executor).complete(connectCtx(pkg.id), {
      kind: "fields",
      credentials: { identifiant: "user1", mot_de_passe: "s3cr3t" },
    });
    expect(captured.inputFields).toEqual(["identifiant", "mot_de_passe"]);
    expect(JSON.stringify(captured)).not.toContain("s3cr3t");
  });
});

describe("OrchestratedStrategy.reacquire — re-bootstrap from persisted secret (Phase 5)", () => {
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

  it("re-runs the tool with the persisted secret and writes the fresh session back", async () => {
    const pkg = await seedPackage({
      id: "@orga/wajax-re",
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: orchestratedManifest("@orga/wajax-re", true),
    });
    // First connect captures sess-1 + persists the login secret.
    let issued = "sess-1";
    let lastInputs: Record<string, string> = {};
    const executor: ConnectToolExecutor = {
      run: async (exec) => {
        lastInputs = exec.inputs;
        return { outputs: { JSESSIONID: issued }, expiresAt: null };
      },
    };
    const strategy = new OrchestratedStrategy(executor);
    const summary = await strategy.complete(connectCtx(pkg.id), {
      kind: "fields",
      credentials: { identifiant: "user1", mot_de_passe: "s3cr3t" },
    });

    const [before] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, summary.id));

    // Session expired mid-run → reacquire re-bootstraps with the stored secret.
    issued = "sess-2";
    const result = await strategy.reacquire({
      connectionId: summary.id,
      packageId: pkg.id,
      authKey: "session",
      credentialsEncrypted: before!.credentialsEncrypted,
      refreshContext: {} as never,
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
    });

    // Tool was driven with the persisted secret (re-bootstrap, no re-prompt).
    expect(lastInputs).toEqual({ identifiant: "user1", mot_de_passe: "s3cr3t" });
    expect(result.fields).toEqual({ JSESSIONID: "sess-2" });

    // Fresh outputs written back; the login secret survives for the next re-run.
    const [after] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, summary.id));
    expect(decryptCredentialsToStringMap(after!.credentialsEncrypted)).toEqual({
      JSESSIONID: "sess-2",
    });
    expect(decryptCredentialInputsToStringMap(after!.credentialsEncrypted)).toEqual({
      identifiant: "user1",
      mot_de_passe: "s3cr3t",
    });
  });

  it("throws revoked when there is no persisted secret to re-bootstrap", async () => {
    const pkg = await seedPackage({
      id: "@orga/wajax-nore",
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: orchestratedManifest("@orga/wajax-nore", false), // persistLoginSecret off
    });
    const strategy = new OrchestratedStrategy(fakeExecutor);
    const summary = await strategy.complete(connectCtx(pkg.id), {
      kind: "fields",
      credentials: { identifiant: "user1", mot_de_passe: "s3cr3t" },
    });
    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, summary.id));

    await expect(
      strategy.reacquire({
        connectionId: summary.id,
        packageId: pkg.id,
        authKey: "session",
        credentialsEncrypted: row!.credentialsEncrypted,
        refreshContext: {} as never,
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      }),
    ).rejects.toMatchObject({ kind: "revoked" });
  });
});
