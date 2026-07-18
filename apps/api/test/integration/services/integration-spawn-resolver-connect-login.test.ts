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
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { LoginSecretStrategy } from "../../../src/services/connect/login-secret-strategy.ts";
import type { ConnectContext } from "../../../src/services/connect/strategy.ts";
import { resolveIntegrationSpawns } from "../../../src/services/integration-spawn-resolver.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage, seedPackageVersion } from "../../helpers/seed.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
  connectToolBlock,
  mcpServerManifest,
} from "../../helpers/integration-manifests.ts";

const INTEG = "@orga/wajax-spawn";
const MCP_SERVER = "@orga/wajax-server";

function runStartManifest(name = INTEG): IntegrationManifest {
  return localIntegrationManifest({
    name,
    serverName: MCP_SERVER,
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
    // The agent may pick `fetch_invoices`; the login tool itself must never
    // surface to the agent regardless of selection.
    tools_policy: { fetch_invoices: {}, login: {} },
  });
}

/**
 * Agent manifest selecting both a real tool AND the login tool (to prove the
 * resolver strips `login` from the allowlist even when an author lists it).
 */
function agentManifest(): Record<string, unknown> {
  return {
    schema_version: "0.2",
    type: "agent",
    name: "@orga/agent",
    version: "0.1.0",
    display_name: "Orga Agent",
    dependencies: {
      integrations: { [INTEG]: "^0.1.0" },
    },
    integrations_configuration: { [INTEG]: { tools: ["fetch_invoices", "login"] } },
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
    // The integration's `source.kind: "local"` references a separate mcp-server
    // package; the spawn resolver looks it up for the runnable server config.
    const serverManifest = mcpServerManifest({
      name: MCP_SERVER,
      version: "0.1.0",
      serverType: "node",
    });
    await seedPackage({
      id: MCP_SERVER,
      orgId: ctx.orgId,
      type: "mcp-server",
      source: "local",
      draftManifest: serverManifest,
    });
    await seedPackageVersion({
      packageId: MCP_SERVER,
      version: "0.1.0",
      manifest: serverManifest,
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
  });

  function connectCtx(): ConnectContext {
    return {
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      actor: { type: "user", id: ctx.user.id },
      integrationId: INTEG,
      authKey: "session",
    } as ConnectContext;
  }

  it("populates connectLogin (inputs decrypted, login tool excluded) when a secret is stored", async () => {
    await new LoginSecretStrategy().complete(connectCtx(), {
      kind: "fields",
      credentials: { identifiant: "user1", mot_de_passe: "s3cr3t" },
    });

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
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
      in: "header",
      name: "Cookie",
      value: "{$credential.JSESSIONID}",
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
      integrationId: INTEG,
      authKey: "session",
      accountId: "default",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      endUserId: null,
      // Empty inputs plane → decryptCredentialInputsToStringMap → {}
      credentialsEncrypted: encryptCredentialEnvelope({ outputs: {} }),
      identityClaims: {},
      scopesGranted: [],
      needsReconnection: false,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });

    expect(specs.length).toBe(0);
  });

  it("copies manifest auth.connect reauth_on into connectLogin", async () => {
    // Re-seed the integration with a manifest that declares reauth_on (AFPS:
    // under connect._meta["dev.appstrate/connect"].reauth_on).
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
    const manifest = localIntegrationManifest({
      name: INTEG,
      serverName: MCP_SERVER,
      version: "0.1.0",
      displayName: "OrgaBusiness",
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
            reauthOn: [401, 419],
          }),
        },
      },
      tools_policy: { fetch_invoices: {}, login: {} },
    });
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest,
    });
    const serverManifest = mcpServerManifest({
      name: MCP_SERVER,
      version: "0.1.0",
      serverType: "node",
    });
    await seedPackage({
      id: MCP_SERVER,
      orgId: ctx.orgId,
      type: "mcp-server",
      source: "local",
      draftManifest: serverManifest,
    });
    await seedPackageVersion({
      packageId: MCP_SERVER,
      version: "0.1.0",
      manifest: serverManifest,
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await new LoginSecretStrategy().complete(connectCtx(), {
      kind: "fields",
      credentials: { identifiant: "user1", mot_de_passe: "s3cr3t" },
    });

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest(),
    });

    expect(specs.length).toBe(1);
    expect(specs[0]!.connectLogin!.reauthOn).toEqual([401, 419]);
  });

  // AFPS §4.4 wildcard + §7.8 — security regression test. When the agent
  // opts into every upstream tool via `tools: "*"`, the McpHost allowlist
  // is disabled (`toolAllowlist === undefined`). The connect-login tool
  // would then reach the agent's LLM unless the resolver also unions its
  // name into `hiddenTools`. This test pins that behavior.
  it('wildcard tools = "*" still hides the connect-login tool via hiddenTools', async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
    // Wildcard requires `allow_undeclared_tools: true` AND at least one auth
    // with non-empty `default_scopes` (enforced by core schema superRefine).
    const manifest = localIntegrationManifest({
      name: INTEG,
      serverName: MCP_SERVER,
      version: "0.1.0",
      displayName: "OrgaBusiness",
      auths: {
        session: {
          type: "custom",
          authorizedUris: ["https://saas.example.com/**"],
          credentialFields: ["identifiant", "mot_de_passe"],
          delivery: httpHeaderDelivery({ name: "Cookie", field: "JSESSIONID" }),
          // `default_scopes` is informational for a custom auth (no consent
          // step) but satisfies the schema gate for `allow_undeclared_tools`.
          defaultScopes: ["session:read"],
          connect: connectToolBlock({
            tool: "login",
            runAt: "run-start",
            persistLoginSecret: true,
            produces: ["JSESSIONID"],
          }),
        },
      },
      tools_policy: { fetch_invoices: {}, login: {} },
      allow_undeclared_tools: true,
    });
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest,
    });
    const serverManifest = mcpServerManifest({
      name: MCP_SERVER,
      version: "0.1.0",
      serverType: "node",
    });
    await seedPackage({
      id: MCP_SERVER,
      orgId: ctx.orgId,
      type: "mcp-server",
      source: "local",
      draftManifest: serverManifest,
    });
    await seedPackageVersion({
      packageId: MCP_SERVER,
      version: "0.1.0",
      manifest: serverManifest,
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);

    await new LoginSecretStrategy().complete(connectCtx(), {
      kind: "fields",
      credentials: { identifiant: "user1", mot_de_passe: "s3cr3t" },
    });

    const wildcardAgent: Record<string, unknown> = {
      schema_version: "0.2",
      type: "agent",
      name: "@orga/agent",
      version: "0.1.0",
      display_name: "Orga Agent",
      dependencies: { integrations: { [INTEG]: "^0.1.0" } },
      integrations_configuration: { [INTEG]: { tools: "*" } },
    };

    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: wildcardAgent,
    });

    expect(specs.length).toBe(1);
    const spec = specs[0]!;
    // Wildcard surfaces every upstream tool — no allowlist filter on the spec.
    expect(spec.toolAllowlist).toBeUndefined();
    // …but the connect-login tool MUST still be filtered server-side via
    // `hiddenTools`, otherwise the LLM could call it.
    expect(spec.hiddenTools).toBeDefined();
    expect(spec.hiddenTools).toContain("login");
    // ConnectLogin metadata is still populated (the sidecar uses it to mint
    // the session at boot before the agent connects).
    expect(spec.connectLogin).toBeDefined();
    expect(spec.connectLogin!.toolName).toBe("login");
  });
});
