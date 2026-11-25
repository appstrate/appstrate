// SPDX-License-Identifier: Apache-2.0

/**
 * Spawn resolver — the space's tool policy reaches the sidecar: blocked tools through
 * `hiddenTools`, and on a closed remote catalog the fingerprints approved for each undeclared
 * tool the agent names through `approvedToolFingerprints` (never for a declared tool, never on an
 * open catalog).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { spaceIntegrationToolApprovals, spaceIntegrationToolBlocks } from "@appstrate/db/schema";
import { resolveIntegrationSpawns } from "../../helpers/spawn-resolver.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpacePackage } from "../../helpers/seed.ts";

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
    db.insert(spaceIntegrationToolApprovals).values({
      spaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      packageId: INTEG,
      toolName,
      fingerprint: FINGERPRINT,
      definition: {},
    });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
  });

  it("hides the tools the space blocked", async () => {
    await seed();
    await db.insert(spaceIntegrationToolBlocks).values({
      spaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      packageId: INTEG,
      toolName: "search",
    });
    const spec = await spawn(["search"]);
    expect(spec.hiddenTools).toEqual(["search"]);
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

  it("does not gate an open catalog", async () => {
    await seed(true);
    const spec = await spawn(["search", "write"]);
    expect(spec.approvedToolFingerprints).toBeUndefined();
  });
});
