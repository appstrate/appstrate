// SPDX-License-Identifier: Apache-2.0

/**
 * Spawn resolver — integration `default_tools` inheritance (AFPS §4.4).
 *
 * An api-only integration may declare `default_tools`. An agent that depends on
 * the integration but omits `integrations_configuration.<id>` inherits that
 * selection; an explicit selection (including an empty array) overrides it.
 *
 * Verifies that:
 *  - a zero-config agent inherits the integration's `default_tools: ["api_call"]`
 *    → the spec exposes the `api_call` tool;
 *  - an explicit `tools: []` overrides the default → no `api_call`;
 *  - an explicit `tools: ["other"]` overrides the default → no `api_call`;
 *  - WITHOUT a declared `default_tools`, a zero-config agent gets nothing
 *    (the default is opt-in — there is no implicit api_call injection).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";

import { resolveIntegrationSpawns } from "../../../src/services/integration-spawn-resolver.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage } from "../../helpers/seed.ts";
import { apiIntegrationManifest } from "../../helpers/integration-manifests.ts";

const INTEG = "@orga/gmailish";

/** api-only integration exposing `api_call`, with a viable `delivery.env` so the
 *  spec is produced regardless of whether api_call is selected. */
function integManifest(opts: { defaultTools?: string[] | "*" }) {
  return apiIntegrationManifest({
    name: INTEG,
    version: "1.0.0",
    apiCall: { authKey: "primary" },
    ...(opts.defaultTools ? { defaultTools: opts.defaultTools } : {}),
    auths: {
      primary: {
        type: "api_key",
        authorizedUris: ["https://api.example.com/**"],
        credentialFields: ["api_key"],
        delivery: { env: { TOKEN: { value: "{$credential.api_key}" } } },
      },
    },
  });
}

function agentManifest(
  integrationsConfiguration?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schema_version: "0.2",
    type: "agent",
    name: "@orga/agent",
    version: "0.1.0",
    display_name: "Agent",
    dependencies: { integrations: { [INTEG]: "^1.0.0" } },
    ...(integrationsConfiguration ? { integrations_configuration: integrationsConfiguration } : {}),
  };
}

async function seedConnection(ctx: TestContext) {
  await db.insert(integrationConnections).values({
    integrationId: INTEG,
    authKey: "primary",
    accountId: "default",
    applicationId: ctx.defaultAppId,
    userId: ctx.user.id,
    endUserId: null,
    credentialsEncrypted: encryptCredentialEnvelope({ outputs: { api_key: "k-1" } }),
    identityClaims: {},
    scopesGranted: [],
    needsReconnection: false,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedAndResolve(
  ctx: TestContext,
  opts: { defaultTools?: string[] | "*"; integrationsConfiguration?: Record<string, unknown> },
) {
  await seedPackage({
    id: INTEG,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: integManifest({ defaultTools: opts.defaultTools }),
  });
  await seedInstalledPackage(ctx.defaultAppId, INTEG);
  await seedConnection(ctx);
  return resolveIntegrationSpawns({
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    actor: { type: "user", id: ctx.user.id },
    agentManifest: agentManifest(opts.integrationsConfiguration),
  });
}

describe("resolveIntegrationSpawns — integration default_tools (AFPS §4.4)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  it("a zero-config agent inherits default_tools: ['api_call'] → api_call exposed", async () => {
    const specs = await seedAndResolve(ctx, { defaultTools: ["api_call"] });
    expect(specs.length).toBe(1);
    const spec = specs[0]!;
    expect(spec.apiCalls).toBeDefined();
    expect(spec.apiCalls!.map((c) => c.toolName)).toEqual(["api_call"]);
    expect(spec.toolAllowlist).toContain("api_call");
  });

  it("an explicit tools: [] overrides the default → no api_call", async () => {
    const specs = await seedAndResolve(ctx, {
      defaultTools: ["api_call"],
      integrationsConfiguration: { [INTEG]: { tools: [] } },
    });
    expect(specs.length).toBe(1);
    const spec = specs[0]!;
    expect(spec.apiCalls).toBeUndefined();
    expect(spec.toolAllowlist).toEqual([]);
  });

  it("an explicit tools: ['other'] overrides the default → no api_call", async () => {
    const specs = await seedAndResolve(ctx, {
      defaultTools: ["api_call"],
      integrationsConfiguration: { [INTEG]: { tools: ["other"] } },
    });
    expect(specs.length).toBe(1);
    const spec = specs[0]!;
    expect(spec.apiCalls).toBeUndefined();
    expect(spec.toolAllowlist).toEqual(["other"]);
  });

  it("WITHOUT a declared default_tools, a zero-config agent gets nothing (opt-in, no implicit injection)", async () => {
    const specs = await seedAndResolve(ctx, {});
    expect(specs.length).toBe(1);
    const spec = specs[0]!;
    expect(spec.apiCalls).toBeUndefined();
    expect(spec.toolAllowlist).toEqual([]);
  });
});
