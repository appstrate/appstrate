// SPDX-License-Identifier: Apache-2.0

/**
 * The Appstrate runtime override must reach a CONNECT login's spawn spec, not
 * just an agent run's.
 *
 * MCPB has no `bun` server type, so a bun-native mcp-server keeps an
 * MCPB-vocabulary `server.type: "node"` and declares the real runtime in
 * `_meta["dev.appstrate/mcp-server"].runtime`. `integration-spawn-resolver.ts`
 * has always honoured that on the agent path; the connect path forwarded the
 * raw `server.type`, so the SAME package spawned under bun for an agent run and
 * under node for a connect login.
 *
 * This exercises the DEFAULT resolver deliberately — the unit suite injects one,
 * which is exactly why the divergence survived there. The override is applied at
 * the resolution boundary, so an injected resolver cannot prove anything about
 * it.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import {
  localIntegrationManifest,
  mcpServerManifest,
} from "../../helpers/integration-manifests.ts";
import { connectToolBlock } from "../../helpers/integration-manifests.ts";
import { buildConnectLoginSpec } from "../../../src/services/connect/connect-run-launcher.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { ConnectToolExecution } from "../../../src/services/connect/orchestrated-strategy.ts";

const INTEGRATION_ID = "@rt/portal";
const SERVER_ID = "@rt/portal-server";

function manifestWithConnectTool(): IntegrationManifest {
  return localIntegrationManifest({
    name: INTEGRATION_ID,
    serverName: SERVER_ID,
    auths: {
      session: {
        type: "custom",
        authorizedUris: ["https://portal.example.test/**"],
        credentialFields: ["email", "password"],
        connect: connectToolBlock({ tool: "login", runAt: "link", produces: ["session_token"] }),
      },
    },
  });
}

async function seedPair(ctx: TestContext, appstrateRuntime?: string): Promise<void> {
  await seedPackage({
    id: INTEGRATION_ID,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: manifestWithConnectTool(),
  });
  const server = mcpServerManifest({
    name: SERVER_ID,
    version: "1.0.0",
    serverType: "node",
    ...(appstrateRuntime ? { appstrateRuntime } : {}),
  });
  await seedPackage({
    id: SERVER_ID,
    orgId: ctx.orgId,
    type: "mcp-server",
    source: "local",
    draftManifest: server,
  });
  // Published, not draft: the resolver reads the published-version kernel, and
  // the byte route serves only out of `package_versions`.
  await seedPackageVersion({ packageId: SERVER_ID, version: "1.0.0", manifest: server });
}

function execution(ctx: TestContext): ConnectToolExecution {
  return {
    integrationId: INTEGRATION_ID,
    authKey: "session",
    manifest: manifestWithConnectTool(),
    scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
    toolName: "login",
    inputs: {},
    inputFields: ["email", "password"],
  };
}

describe("connect login spec — Appstrate runtime override", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "rt" });
  });

  it("carries the `_meta` runtime, not the MCPB `server.type`", async () => {
    await seedPair(ctx, "bun");

    const spec = await buildConnectLoginSpec(execution(ctx));

    // Without the override the spec says "node" and the login spawns under the
    // wrong interpreter — silently, since node will happily start a bun-native
    // entry point and fail later.
    expect(spec.manifest.server?.type).toBe("bun");
    expect(spec.manifest.server?.packageId).toBe(SERVER_ID);
  });

  // Control: without the override the MCPB type must survive untouched. A fix
  // that hard-coded "bun", or dropped `server.type` entirely, passes the case
  // above and fails this one.
  it("leaves `server.type` alone when no runtime override is declared", async () => {
    await seedPair(ctx);

    const spec = await buildConnectLoginSpec(execution(ctx));

    expect(spec.manifest.server?.type).toBe("node");
  });
});
