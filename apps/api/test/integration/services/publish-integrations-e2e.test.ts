// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end regression for the prompt-only-agent integration-stripping bug.
 *
 * A prompt-only agent (no skills) that declared integrations used to lose its
 * entire `dependencies.integrations` block when a version was cut from the
 * draft (buildDependencies returned null → the block was deleted). The
 * published manifest then carried only `integrations_configuration`, so at run
 * time `resolveIntegrationSpawns` parsed zero integrations and the agent saw
 * `tool_not_found` for every integration tool.
 *
 * This suite closes the loop the unit tests leave open: it does not just assert
 * the published manifest keeps the data — it feeds the PUBLISHED version's
 * manifest through the exact resolver the run pipeline uses and asserts the
 * integration is spawned with its declared tool in the allowlist.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { integrationConnections, packageVersions } from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";

import { resolveIntegrationSpawns } from "../../../src/services/integration-spawn-resolver.ts";
import { createVersionFromDraft } from "../../../src/services/package-versions.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage, seedPackageVersion } from "../../helpers/seed.ts";
import {
  localIntegrationManifest,
  mcpServerManifest,
} from "../../helpers/integration-manifests.ts";

const INTEG = "@e2eorg/fathom";
const SERVER = "@e2eorg/fathom-server";
const AGENT = "@e2eorg/prompt-only";

/** Prompt-only agent (no skills) declaring the integration + one of its tools. */
function agentDraftManifest(): Record<string, unknown> {
  return {
    schema_version: "0.2",
    type: "agent",
    name: AGENT,
    version: "1.0.0",
    display_name: "Prompt Only",
    description: "Prompt-only agent with one integration, zero skills",
    dependencies: { integrations: { [INTEG]: "^1.0.0" } },
    integrations_configuration: { [INTEG]: { tools: ["search"], auth_key: "primary" } },
  };
}

describe("publish → resolveIntegrationSpawns (prompt-only agent, e2e)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "e2eorg" });
  });

  it("a published prompt-only agent resolves its integration tool from the stored version manifest", async () => {
    // ── integration + its mcp-server, installed + connected ──
    await seedPackage({
      id: INTEG,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: localIntegrationManifest({
        name: INTEG,
        version: "1.0.0",
        serverName: SERVER,
        auths: {
          primary: {
            type: "api_key",
            authorizedUris: ["https://api.fathom.test/**"],
            credentialFields: ["api_key"],
            delivery: { env: { API_KEY: { value: "{$credential.api_key}", sensitive: true } } },
          },
        },
        tools_policy: { search: {} },
      }),
    });
    await seedInstalledPackage(ctx.defaultAppId, INTEG);
    await seedPackage({
      id: SERVER,
      orgId: ctx.orgId,
      type: "mcp-server",
      source: "local",
      draftManifest: mcpServerManifest({ name: SERVER, version: "1.0.0", serverType: "node" }),
    });
    await seedPackageVersion({
      packageId: SERVER,
      version: "1.0.0",
      manifest: mcpServerManifest({
        name: SERVER,
        version: "1.0.0",
        serverType: "node",
        entryPoint: "./server.js",
      }),
    });
    await db.insert(integrationConnections).values({
      integrationId: INTEG,
      authKey: "primary",
      accountId: "default",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      endUserId: null,
      credentialsEncrypted: encryptCredentials({ api_key: "secret" }),
      identityClaims: {},
      scopesGranted: [],
      needsReconnection: false,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // ── the prompt-only agent: draft → published version ──
    const agent = await seedPackage({
      id: AGENT,
      orgId: ctx.orgId,
      type: "agent",
      source: "local",
      draftManifest: agentDraftManifest(),
      draftContent: "Do the sync.",
    });

    const result = await createVersionFromDraft({
      packageId: agent.id,
      orgId: ctx.orgId,
      userId: ctx.user.id,
    });
    expect("error" in result).toBe(false);

    // Read back the PUBLISHED, immutable manifest (not the draft).
    const [stored] = await db
      .select({ manifest: packageVersions.manifest })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, AGENT), eq(packageVersions.version, "1.0.0")))
      .limit(1);
    const publishedManifest = stored!.manifest as Record<string, unknown>;

    // ── run-pipeline resolution against the published manifest ──
    const specs = await resolveIntegrationSpawns({
      applicationId: ctx.defaultAppId,
      actor: { type: "user", id: ctx.user.id },
      agentManifest: publishedManifest,
    });

    // The bug produced []; the integration's declared tool must now resolve.
    expect(specs.length).toBe(1);
    expect(specs[0]!.integrationId).toBe(INTEG);
    expect(specs[0]!.toolAllowlist).toEqual(["search"]);
  });
});
