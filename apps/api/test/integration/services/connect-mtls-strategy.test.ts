// SPDX-License-Identifier: Apache-2.0

/**
 * mtls auth type — connect strategy + end-to-end persistence (AFPS 2.0.2 §7.2,
 * CC-6). mtls reuses FieldsStrategy: the user pastes a credential bag (client
 * cert PEM + private key PEM), the manifest's `credentials.schema` validates
 * the shape, and the bag is stored on the connection. At runtime the integration
 * spawn resolver materialises those fields into `delivery.files` entries (E1)
 * that the runtime adapter writes to the runner's filesystem at the
 * manifest-declared paths.
 */

import { describe, it, expect, beforeEach } from "bun:test";

import { resolveStrategy } from "../../../src/services/connect/registry.ts";
import { FieldsStrategy } from "../../../src/services/connect/fields-strategy.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { localIntegrationManifest, filesDelivery } from "../../helpers/integration-manifests.ts";
import { integrationConnections } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";

const INTEG = "@orga/mtls-integ";

function mtlsManifest() {
  return localIntegrationManifest({
    name: INTEG,
    version: "0.1.0",
    auths: {
      primary: {
        type: "mtls",
        authorizedUris: ["https://api.example.com/**"],
        credentialFields: ["client_cert", "client_key"],
        delivery: filesDelivery({
          "/run/creds/client.pem": { field: "client_cert" },
          "/run/creds/client.key": { field: "client_key", mode: "0400" },
        }),
      },
    },
    tools_policy: { call: {} },
  });
}

describe("mtls connect strategy", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  it("resolves to FieldsStrategy (paste-the-bag, no begin step)", () => {
    const strategy = resolveStrategy({ type: "mtls" } as never);
    expect(strategy).toBeInstanceOf(FieldsStrategy);
    expect(strategy.begin).toBeUndefined();
  });

  it("persists a cert + key bag through the fields flow", async () => {
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: mtlsManifest(),
    });

    const strategy = new FieldsStrategy();
    const cert = "-----BEGIN CERTIFICATE-----\nMIIBkTCB\n-----END CERTIFICATE-----";
    const key = "-----BEGIN PRIVATE KEY-----\nMIGHAgEA\n-----END PRIVATE KEY-----";
    const conn = await strategy.complete(
      {
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        actor: { type: "user", id: ctx.user.id },
        integrationId: INTEG,
        authKey: "primary",
      },
      { kind: "fields", credentials: { client_cert: cert, client_key: key } },
    );

    expect(conn).toBeDefined();
    expect(conn.auth_key).toBe("primary");
    expect(conn.packageId).toBe(INTEG);

    // Defence-in-depth: verify the row in DB exists for this user + app.
    const rows = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, conn.id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.authKey).toBe("primary");
  });

  it("rejects an empty credentials bag", async () => {
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: mtlsManifest(),
    });
    const strategy = new FieldsStrategy();
    await expect(
      strategy.complete(
        {
          scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
          actor: { type: "user", id: ctx.user.id },
          integrationId: INTEG,
          authKey: "primary",
        },
        { kind: "fields", credentials: {} },
      ),
    ).rejects.toThrow(/cannot be empty/);
  });

  it("rejects credentials missing required schema fields (cert without key)", async () => {
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: (() => {
        const m = mtlsManifest();
        // Make the credentials schema require both fields explicitly — the
        // builder leaves required out by default; tighten it for this case.
        const auths = (
          m as { auths: Record<string, { credentials?: { schema: Record<string, unknown> } }> }
        ).auths;
        auths.primary!.credentials = {
          schema: {
            type: "object",
            properties: {
              client_cert: { type: "string" },
              client_key: { type: "string" },
            },
            required: ["client_cert", "client_key"],
          },
        };
        return m;
      })(),
    });

    const strategy = new FieldsStrategy();
    await expect(
      strategy.complete(
        {
          scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
          actor: { type: "user", id: ctx.user.id },
          integrationId: INTEG,
          authKey: "primary",
        },
        // Only cert, no key — schema validation must catch this.
        { kind: "fields", credentials: { client_cert: "cert-only" } },
      ),
    ).rejects.toThrow(/schema/);
  });
});
