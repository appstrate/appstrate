// SPDX-License-Identifier: Apache-2.0

/**
 * Spawn resolver — the `api_upload` companion tool (issue #881).
 *
 * An api_call auth that declares `_meta["dev.appstrate/api"].auths.<key>
 * .upload_protocols` also exposes an `api_upload` tool: the sidecar advertises
 * it (`makeApiUploadTool`) and the agent-side Pi extension drives it, chunk by
 * chunk, through the sibling `api_call` tool.
 *
 * Because the upload orchestration dispatches through `api_call`, the two are
 * granted as a pair — selecting either name yields both. Verifies that:
 *  - a selection naming only `api_call` still plumbs `uploadProtocols`
 *    (so the sidecar advertises `api_upload`);
 *  - a selection naming only `api_upload` grants the api_call capability too;
 *  - naming both yields exactly one api_call spec (no duplicate);
 *  - `tools: []` grants neither;
 *  - `api_upload` on an auth that declares NO `upload_protocols` grants nothing
 *    (the companion doesn't exist — the name must not act as a backdoor).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";

import { resolveIntegrationSpawns } from "../../../src/services/integration-spawn-resolver.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage } from "../../helpers/seed.ts";
import { apiIntegrationManifest } from "../../helpers/integration-manifests.ts";

const INTEG = "@orga/driveish";
const PROTOCOLS = ["google-resumable"];

/** `@appstrate/google-drive`'s shape: serverless, one auth, one upload protocol. */
function integManifest(opts: { uploadProtocols?: string[]; defaultTools?: string[] }) {
  return apiIntegrationManifest({
    name: INTEG,
    version: "1.0.0",
    apiCall: {
      authKey: "primary",
      ...(opts.uploadProtocols ? { uploadProtocols: opts.uploadProtocols } : {}),
    },
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

function agentManifest(tools?: string[] | "*", authKey?: string): Record<string, unknown> {
  return {
    schema_version: "0.2",
    type: "agent",
    name: "@orga/agent",
    version: "0.1.0",
    display_name: "Agent",
    dependencies: { integrations: { [INTEG]: "^1.0.0" } },
    ...(tools !== undefined || authKey !== undefined
      ? {
          integrations_configuration: {
            [INTEG]: {
              ...(tools !== undefined ? { tools } : {}),
              ...(authKey !== undefined ? { auth_key: authKey } : {}),
            },
          },
        }
      : {}),
  };
}

async function seedConnection(ctx: TestContext, authKey = "primary") {
  await db.insert(integrationConnections).values({
    integrationId: INTEG,
    authKey,
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
  opts: { uploadProtocols?: string[]; defaultTools?: string[]; tools?: string[] | "*" },
) {
  await seedPackage({
    id: INTEG,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: integManifest(opts),
  });
  await seedInstalledPackage(ctx.defaultAppId, INTEG);
  await seedConnection(ctx);
  const specs = await resolveIntegrationSpawns({
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    actor: { type: "user", id: ctx.user.id },
    agentManifest: agentManifest(opts.tools),
  });
  expect(specs.length).toBe(1);
  return specs[0]!;
}

describe("resolveIntegrationSpawns — api_upload companion (#881)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  it("selecting api_call plumbs uploadProtocols so the sidecar advertises api_upload", async () => {
    const spec = await seedAndResolve(ctx, { uploadProtocols: PROTOCOLS, tools: ["api_call"] });
    expect(spec.apiCalls).toBeDefined();
    expect(spec.apiCalls!).toHaveLength(1);
    expect(spec.apiCalls![0]!.toolName).toBe("api_call");
    expect(spec.apiCalls![0]!.uploadProtocols).toEqual(PROTOCOLS);
  });

  it("inheriting default_tools: ['api_call'] plumbs uploadProtocols too", async () => {
    const spec = await seedAndResolve(ctx, {
      uploadProtocols: PROTOCOLS,
      defaultTools: ["api_call"],
    });
    expect(spec.apiCalls![0]!.uploadProtocols).toEqual(PROTOCOLS);
  });

  it("selecting only api_upload grants the api_call capability it dispatches through", async () => {
    const spec = await seedAndResolve(ctx, { uploadProtocols: PROTOCOLS, tools: ["api_upload"] });
    expect(spec.apiCalls).toBeDefined();
    expect(spec.apiCalls!).toHaveLength(1);
    expect(spec.apiCalls![0]!.toolName).toBe("api_call");
    expect(spec.apiCalls![0]!.uploadProtocols).toEqual(PROTOCOLS);
  });

  it("selecting both names yields exactly one api_call spec", async () => {
    const spec = await seedAndResolve(ctx, {
      uploadProtocols: PROTOCOLS,
      tools: ["api_call", "api_upload"],
    });
    expect(spec.apiCalls!).toHaveLength(1);
    expect(spec.toolAllowlist).toEqual(["api_call", "api_upload"]);
  });

  it("the wildcard auto-grants the pair", async () => {
    const spec = await seedAndResolve(ctx, { uploadProtocols: PROTOCOLS, tools: "*" });
    expect(spec.apiCalls![0]!.uploadProtocols).toEqual(PROTOCOLS);
  });

  it("tools: [] grants neither api_call nor api_upload", async () => {
    const spec = await seedAndResolve(ctx, { uploadProtocols: PROTOCOLS, tools: [] });
    expect(spec.apiCalls).toBeUndefined();
  });

  it("api_upload on an auth without upload_protocols grants nothing", async () => {
    const spec = await seedAndResolve(ctx, { tools: ["api_upload"] });
    expect(spec.apiCalls).toBeUndefined();
    expect(spec.toolAllowlist).toEqual(["api_upload"]);
  });

  it("without upload_protocols, api_call carries no uploadProtocols", async () => {
    const spec = await seedAndResolve(ctx, { tools: ["api_call"] });
    expect(spec.apiCalls![0]!.uploadProtocols).toBeUndefined();
  });

  it("canonicalizes persisted long-name selections and hidden_tools aliases", async () => {
    const longAuthKey = "authentication_key_that_is_valid_but_long";
    const legacyCall = `api_call__${longAuthKey}`;
    const legacyUpload = `api_upload__${longAuthKey}`;
    const canonicalCall = "api_call__h0a0593260c3968fd8";
    const canonicalUpload = "api_upload__h0a0593260c3968fd8";
    const manifest = apiIntegrationManifest({
      name: INTEG,
      version: "1.0.0",
      auths: {
        primary: {
          type: "api_key",
          authorizedUris: ["https://api.example.com/**"],
          credentialFields: ["api_key"],
        },
        [longAuthKey]: {
          type: "api_key",
          authorizedUris: ["https://api.example.com/**"],
          credentialFields: ["api_key"],
        },
      },
    });
    (manifest as unknown as { _meta: unknown })._meta = {
      "dev.appstrate/api": {
        auths: {
          primary: {},
          [longAuthKey]: { upload_protocols: PROTOCOLS },
        },
      },
    };
    (manifest as unknown as { hidden_tools: string[] }).hidden_tools = [legacyUpload];

    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest,
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedConnection(ctx, longAuthKey);
    const specs = await resolveIntegrationSpawns({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: agentManifest([legacyCall], longAuthKey),
    });

    expect(specs).toHaveLength(1);
    expect(specs[0]!.apiCalls?.[0]?.toolName).toBe(canonicalCall);
    expect(specs[0]!.hiddenTools).toEqual([legacyUpload, canonicalUpload]);
  });
});
