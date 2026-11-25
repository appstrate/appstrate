// SPDX-License-Identifier: Apache-2.0

/**
 * Spawn resolver — the space's tool policy reaches the sidecar: the blocked tools through
 * `blockedTools`, and on a closed remote catalog the fingerprints approved for each undeclared
 * tool the agent names through `approvedToolFingerprints` (never for a declared tool, never on an
 * open catalog).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { MAX_APPROVED_FINGERPRINTS_PER_TOOL } from "@appstrate/core/sidecar-types";
import { db } from "@appstrate/db/client";
import { spaceIntegrationToolBlocks } from "@appstrate/db/schema";
import { resolveIntegrationSpawns } from "../../helpers/spawn-resolver.ts";
import { truncateAll } from "../../helpers/db.ts";
import { insertToolApprovals } from "../../helpers/tool-policy.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpacePackage } from "../../helpers/seed.ts";
import { integrationConnections } from "@appstrate/db/schema";
import { encryptCredentialEnvelope } from "@appstrate/connect";
import { apiIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { bindAllConnections } from "../../helpers/bound-connections.ts";

const INTEG = "@orga/remote-mcp";
const FINGERPRINT = "a".repeat(64);

function manifest(open: boolean) {
  return {
    type: "integration",
    schema_version: "0.3",
    name: INTEG,
    version: "0.1.0",
    display_name: "Remote",
    source: {
      kind: "remote",
      remote: { url: "https://mcp.example.com/mcp", transport: "streamable-http" },
    },
    tools_policy: { search: {} },
    ...(open ? { allow_undeclared_tools: true } : {}),
  } as never;
}

describe("resolveIntegrationSpawns — space tool policy", () => {
  let ctx: TestContext;

  async function seed(open = false) {
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest(open),
    });
    await seedSpacePackage(ctx.defaultSpaceId, INTEG);
  }

  async function spawn(tools: string[]) {
    const { specs } = await resolveIntegrationSpawns({
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: {
        schema_version: "0.2",
        type: "agent",
        name: "@orga/agent",
        version: "0.1.0",
        display_name: "Agent",
        dependencies: { integrations: { [INTEG]: "^0.1.0" } },
        integrations_configuration: { [INTEG]: { tools } },
      },
      resolvedConnections: {},
    });
    expect(specs).toHaveLength(1);
    return specs[0]!;
  }

  const approve = (toolName: string) =>
    insertToolApprovals({ ...ctx, spaceId: ctx.defaultSpaceId, packageId: INTEG }, [
      { toolName, fingerprint: FINGERPRINT },
    ]);

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  it("names the tools the space blocked apart from the ones the manifest hides", async () => {
    await seed();
    await db.insert(spaceIntegrationToolBlocks).values({
      spaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      packageId: INTEG,
      toolName: "search",
    });
    const spec = await spawn(["search"]);
    expect(spec.blockedTools).toEqual(["search"]);
    expect(spec.hiddenTools).toBeUndefined();
  });

  it("names the approved fingerprints of each undeclared tool, and none for a declared one", async () => {
    await seed();
    await approve("write");
    const spec = await spawn(["search", "write", "delete"]);
    expect(spec.approvedToolFingerprints).toEqual({ write: [FINGERPRINT], delete: [] });
  });

  it("sends no fingerprint map when every selected tool is declared", async () => {
    await seed();
    const spec = await spawn(["search"]);
    expect(spec.approvedToolFingerprints).toBeUndefined();
  });

  it("expands a wildcard on a closed catalog to the declared and approved tools", async () => {
    await seed();
    await approve("write");
    const spec = await spawn("*" as unknown as string[]);
    expect(spec.toolAllowlist).toEqual(["search", "write"]);
    expect(spec.approvedToolFingerprints).toEqual({ write: [FINGERPRINT] });
  });

  it("leaves a wildcard on an open catalog unrestricted", async () => {
    await seed(true);
    await approve("write");
    const spec = await spawn("*" as unknown as string[]);
    expect(spec.toolAllowlist).toBeUndefined();
    expect(spec.approvedToolFingerprints).toBeUndefined();
  });

  it("caps a tool's fingerprints to the spec limit, the newest approvals first", async () => {
    await seed();
    const total = MAX_APPROVED_FINGERPRINTS_PER_TOOL + 3;
    await insertToolApprovals(
      { ...ctx, spaceId: ctx.defaultSpaceId, packageId: INTEG },
      Array.from({ length: total }, (_, i) => ({
        toolName: "write",
        fingerprint: i.toString(16).padStart(64, "0"),
        approvedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      })),
    );
    const sent = (await spawn(["write"])).approvedToolFingerprints!.write!;
    expect(sent).toHaveLength(MAX_APPROVED_FINGERPRINTS_PER_TOOL);
    expect(sent[0]).toBe((total - 1).toString(16).padStart(64, "0"));
  });

  it("does not gate an open catalog", async () => {
    await seed(true);
    const spec = await spawn(["search", "write"]);
    expect(spec.approvedToolFingerprints).toBeUndefined();
  });

  it("sends every approved fingerprint of a tool, whatever their number: the approval door bounds it", async () => {
    await seed();
    await insertToolApprovals(
      { ...ctx, spaceId: ctx.defaultSpaceId, packageId: INTEG },
      Array.from({ length: 5 }, (_, i) => ({
        toolName: "write",
        fingerprint: i.toString(16).padStart(64, "0"),
      })),
    );
    expect((await spawn(["write"])).approvedToolFingerprints!.write).toHaveLength(5);
  });
});

describe("resolveIntegrationSpawns — a blocked api_call", () => {
  const API = "@orga/driveish";
  let ctx: TestContext;

  let unavailable: { integrationId: string; name: string; reason: string }[] = [];

  async function spawnApi(blocks: string[]) {
    await seedPackage({
      id: API,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: apiIntegrationManifest({
        name: API,
        version: "1.0.0",
        apiCall: { authKey: "primary", uploadProtocols: ["google-resumable"] },
        auths: {
          primary: {
            type: "api_key",
            authorizedUris: ["https://api.example.com/**"],
            credentialFields: ["api_key"],
            delivery: { env: { TOKEN: { value: "{$credential.api_key}" } } },
          },
        },
      }),
    });
    await seedSpacePackage(ctx.defaultSpaceId, API);
    await db.insert(integrationConnections).values({
      integrationId: API,
      authKey: "primary",
      accountId: "default",
      label: "default",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
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
    for (const toolName of blocks) {
      await db.insert(spaceIntegrationToolBlocks).values({
        spaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        packageId: API,
        toolName,
      });
    }
    const result = await resolveIntegrationSpawns({
      spaceId: ctx.defaultSpaceId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: {
        schema_version: "0.2",
        type: "agent",
        name: "@orga/agent",
        version: "0.1.0",
        display_name: "Agent",
        dependencies: { integrations: { [API]: "^1.0.0" } },
        integrations_configuration: { [API]: { tools: ["api_call"] } },
      },
      resolvedConnections: await bindAllConnections(API),
    });
    unavailable = result.unavailable;
    return result.specs[0]!;
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  it("is not granted to the run, upload companion included", async () => {
    const spec = await spawnApi(["api_call"]);
    expect(spec.apiCalls).toBeUndefined();
    // Removed here: the sidecar is told of no `api_call` block, so the resolver reports it.
    expect(spec.blockedTools).toBeUndefined();
    expect(unavailable).toEqual([
      { integrationId: API, name: "api_call", reason: "blocked_in_space" },
    ]);
  });

  it("keeps the call when only its upload companion is blocked", async () => {
    const spec = await spawnApi(["api_upload"]);
    expect(spec.apiCalls).toHaveLength(1);
    expect(spec.apiCalls![0]!.uploadProtocols).toBeUndefined();
    expect(unavailable.map((t) => t.name)).toEqual(["api_upload"]);
  });
});
