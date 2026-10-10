// SPDX-License-Identifier: Apache-2.0

/**
 * A non-string credential, end to end (#1897): accepted at write time by the
 * manifest's `credentials.schema` (AFPS §7.5 allows any JSON type), stored as
 * that type, then rendered into the sidecar's delivery plan. Before the fix the
 * read side kept strings only, so `{$credential.port}` rendered empty while the
 * connection looked healthy.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { localIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { integrationConnections } from "@appstrate/db/schema";
import { decryptCredentials } from "@appstrate/connect";
import { activatePackage } from "../../../src/services/space-packages.ts";
import { resolveLiveIntegrationCredentials } from "../../../src/services/integration-credentials-resolver.ts";

const app = getTestApp();
const INTEGRATION_ID = "@myorg/pg-gateway";

function typedManifest(): Record<string, unknown> {
  const manifest = localIntegrationManifest({
    name: INTEGRATION_ID,
    auths: {
      primary: {
        type: "api_key",
        authorizedUris: ["https://api.example.com/**"],
        credentialFields: ["api_key"],
        delivery: {
          http: {
            in: "header",
            name: "X-Gateway",
            value: "{$credential.api_key};{$credential.port};{$credential.tls};{$credential.hosts}",
          },
        },
      },
    },
  }) as unknown as { auths: { primary: { credentials: { schema: Record<string, unknown> } } } };
  manifest.auths.primary.credentials.schema = {
    type: "object",
    properties: {
      api_key: { type: "string" },
      port: { type: "integer" },
      tls: { type: "boolean" },
      hosts: { type: "array", items: { type: "string" } },
    },
    required: ["api_key", "port", "tls", "hosts"],
  };
  return manifest as unknown as Record<string, unknown>;
}

describe("non-string credentials reach the delivery plan (#1897)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedPackage({
      id: INTEGRATION_ID,
      orgId: ctx.orgId,
      homeSpaceId: ctx.defaultSpaceId,
      type: "integration",
      source: "local",
      draftManifest: typedManifest(),
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, INTEGRATION_ID);
  });

  it("stores the declared types and delivers each one JSON-encoded", async () => {
    const post = await app.request(
      `/api/integrations/${INTEGRATION_ID}/auths/primary/connect/fields`,
      {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          credentials: { api_key: "k", port: 5432, tls: false, hosts: ["db1", "db2"] },
        }),
      },
    );
    expect(post.status, await post.clone().text()).toBe(200);
    const { id } = (await post.json()) as { id: string };

    // Stored as the schema declared them — the write side never stringifies.
    const [row] = await db
      .select({ credentialsEncrypted: integrationConnections.credentialsEncrypted })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id));
    expect(decryptCredentials<{ outputs: unknown }>(row!.credentialsEncrypted!)?.outputs).toEqual({
      api_key: "k",
      port: 5432,
      tls: false,
      hosts: ["db1", "db2"],
    });

    const wire = await resolveLiveIntegrationCredentials(INTEGRATION_ID, {
      runId: "run_test",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      agentPackageId: "@myorg/agent",
      actor: { type: "user", id: ctx.user.id },
      connectionId: id,
      connectionSource: "member_pin",
    });
    expect(wire.auths[0]!.fields).toEqual({
      api_key: "k",
      port: "5432",
      tls: "false",
      hosts: '["db1","db2"]',
    });
    expect(wire.deliveryPlans.primary?.value).toBe('k;5432;false;["db1","db2"]');
  });
});
