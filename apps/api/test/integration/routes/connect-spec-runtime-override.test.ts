// SPDX-License-Identifier: Apache-2.0

/**
 * The Appstrate runtime override must reach a CONNECT login's spawn spec, not
 * just an agent run's.
 *
 * AFPS has no `bun` server type, so a bun-native local server keeps an
 * AFPS-vocabulary `type: "node"` and declares the real runtime in the integration's
 * `_meta["dev.appstrate/mcp-server"].runtime`. `integration-spawn-resolver.ts`
 * honours that on the agent path; the connect path must read it from the same core reader,
 * or the SAME integration spawns under bun for an agent run and under node for a connect login.
 *
 * This exercises the DEFAULT version resolver deliberately (the unit suite injects one), so the
 * spec's `server.version` is proven against the real package store too.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPublishedVersion } from "../../helpers/seed.ts";
import { localIntegrationManifest, connectToolBlock } from "../../helpers/integration-manifests.ts";
import { readIntegrationManifestForConnect } from "../../../src/services/integration-service.ts";
import { buildConnectLoginSpec } from "../../../src/services/connect/connect-run-launcher.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { ConnectToolExecution } from "../../../src/services/connect/orchestrated-strategy.ts";

const INTEGRATION_ID = "@rt/portal";

function manifestWithConnectTool(appstrateRuntime?: string): IntegrationManifest {
  return localIntegrationManifest({
    name: INTEGRATION_ID,
    server: appstrateRuntime ? { appstrateRuntime } : {},
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

async function seedIntegration(
  ctx: TestContext,
  opts: { appstrateRuntime?: string; published?: boolean } = {},
): Promise<IntegrationManifest> {
  const manifest = manifestWithConnectTool(opts.appstrateRuntime);
  await seedPackage({
    id: INTEGRATION_ID,
    orgId: ctx.orgId,
    type: "integration",
    source: "local",
    draftManifest: manifest,
  });
  if (opts.published) {
    await seedPublishedVersion(INTEGRATION_ID, "1.0.0", { manifest });
  }
  return manifest;
}

/** The execution the strategy builds: manifest and version from ONE connect read. */
async function execution(ctx: TestContext): Promise<ConnectToolExecution> {
  const read = await readIntegrationManifestForConnect({ orgId: ctx.orgId }, INTEGRATION_ID);
  if (!read.ok) throw new Error(`connect read failed: ${read.reason}`);
  return {
    integrationId: INTEGRATION_ID,
    authKey: "session",
    manifest: read.manifest,
    bundleVersion: read.version,
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

  it("carries the `_meta` runtime, not `source.server.type`", async () => {
    await seedIntegration(ctx, { appstrateRuntime: "bun" });

    const spec = await buildConnectLoginSpec(await execution(ctx));

    // Without the override the spec says "node" and the login spawns under the
    // wrong interpreter — silently, since node will happily start a bun-native
    // entry point and fail later.
    expect(spec.manifest.server?.type).toBe("bun");
    expect(spec.integrationId).toBe(INTEGRATION_ID);
    expect(spec.manifest.server).not.toHaveProperty("packageId");
  });

  // Control: without the override the declared type must survive untouched. A fix
  // that hard-coded "bun", or dropped `server.type` entirely, passes the case
  // above and fails this one.
  it("leaves `server.type` alone when no runtime override is declared", async () => {
    await seedIntegration(ctx);

    const spec = await buildConnectLoginSpec(await execution(ctx));

    expect(spec.manifest.server?.type).toBe("node");
  });

  it("names the published version whose archive the byte route serves, none for a draft", async () => {
    await seedIntegration(ctx, { published: true });
    const published = await buildConnectLoginSpec(await execution(ctx));
    expect(published.manifest.server?.version).toBe("1.0.0");

    await truncateAll();
    ctx = await createTestContext({ orgSlug: "rt" });
    await seedIntegration(ctx);
    const unpublished = await buildConnectLoginSpec(await execution(ctx));
    expect(unpublished.manifest.server?.version).toBeUndefined();
  });
});
