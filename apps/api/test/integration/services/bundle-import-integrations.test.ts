// SPDX-License-Identifier: Apache-2.0

/**
 * Bundle-import end-to-end for `type: "integration"` packages
 * (INTEGRATIONS_PROPOSAL Phase 1.0 deliverable).
 *
 * Validates that a raw `.afps` carrying an integration manifest can be
 * read, validated, and persisted through the same pipeline used by
 * agents/skills/tools/providers — `handleImportBundle` → `parsePackageZip`
 * → `postInstallPackage` → `packageVersions`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { handleImportBundle } from "../../../src/services/bundle-import.ts";
import { getIntegration, listIntegrations } from "../../../src/services/integration-service.ts";
import { packages, packageVersions } from "@appstrate/db/schema";
import { and, eq } from "drizzle-orm";

const DOS_EPOCH_MS = Date.UTC(1980, 0, 2, 12, 0, 0);

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function buildIntegrationAfps(opts: {
  manifest: Record<string, unknown>;
  serverCode?: string;
  integrationDoc?: string;
}): Uint8Array {
  const entries: Record<string, [Uint8Array, { mtime?: number; level?: number }]> = {
    "manifest.json": [
      enc(JSON.stringify(opts.manifest, null, 2)),
      { mtime: DOS_EPOCH_MS, level: 0 },
    ],
    "server/index.js": [
      enc(opts.serverCode ?? "/* vendored MCP server stub */\n"),
      { mtime: DOS_EPOCH_MS, level: 0 },
    ],
  };
  if (opts.integrationDoc) {
    entries["INTEGRATION.md"] = [enc(opts.integrationDoc), { mtime: DOS_EPOCH_MS, level: 0 }];
  }
  return zipSync(
    entries as unknown as Parameters<typeof zipSync>[0],
    { level: 0, mtime: DOS_EPOCH_MS } as Parameters<typeof zipSync>[1],
  );
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: "1.1",
    type: "integration",
    name: "@official/gmail",
    version: "1.0.0",
    displayName: "Gmail",
    server: { type: "node", entryPoint: "./server/index.js" },
    ...overrides,
  };
}

describe("handleImportBundle — integration packages", () => {
  let ctx: TestContext;
  let scope: { orgId: string; applicationId: string };

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
    scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
  });

  it("imports a minimal integration .afps and persists the package + version", async () => {
    const afps = buildIntegrationAfps({ manifest: validManifest() });
    const result = await handleImportBundle(afps, scope, ctx.user.id);

    expect(result.rootPackageId).toBe("@official/gmail");
    expect(result.rootVersion).toBe("1.0.0");
    expect(result.imported.length).toBe(1);
    expect(result.imported[0]!.status).toBe("inserted");
    expect(result.imported[0]!.versionId).toBeGreaterThan(0);

    // The package row exists, typed as `integration`.
    const [row] = await db
      .select({ id: packages.id, type: packages.type, orgId: packages.orgId })
      .from(packages)
      .where(eq(packages.id, "@official/gmail"));
    expect(row).toBeDefined();
    expect(row!.type).toBe("integration");
    expect(row!.orgId).toBe(ctx.orgId);

    // A version snapshot exists with the manifest preserved.
    const [version] = await db
      .select({ version: packageVersions.version, manifest: packageVersions.manifest })
      .from(packageVersions)
      .where(
        and(eq(packageVersions.packageId, "@official/gmail"), eq(packageVersions.version, "1.0.0")),
      );
    expect(version).toBeDefined();
    expect((version!.manifest as Record<string, unknown>).type).toBe("integration");
  });

  it("surfaces integration via integration-service after import", async () => {
    const afps = buildIntegrationAfps({ manifest: validManifest() });
    await handleImportBundle(afps, scope, ctx.user.id);

    const summary = await getIntegration(ctx.orgId, "@official/gmail");
    expect(summary).not.toBeNull();
    expect(summary!.manifest.displayName).toBe("Gmail");

    const list = await listIntegrations(ctx.orgId);
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBe("@official/gmail");
  });

  it("re-import is idempotent and returns `reused`", async () => {
    const afps = buildIntegrationAfps({ manifest: validManifest() });
    await handleImportBundle(afps, scope, ctx.user.id);
    const second = await handleImportBundle(afps, scope, ctx.user.id);
    expect(second.imported[0]!.status).toBe("reused");
  });

  it("rejects an .afps whose integration manifest is invalid (D32 violation)", async () => {
    // Binary server without httpClient.caTrustEnv → schema rejects.
    const broken = validManifest({
      server: { type: "binary", entryPoint: "./bin/foo" },
    });
    const afps = buildIntegrationAfps({ manifest: broken });
    await expect(handleImportBundle(afps, scope, ctx.user.id)).rejects.toThrow();
  });

  it("rejects an .afps with mismatched type/discriminator (docker without digest)", async () => {
    const broken = validManifest({
      server: {
        type: "docker",
        package: { registryType: "oci", identifier: "x", digest: "latest" },
      },
    });
    const afps = buildIntegrationAfps({ manifest: broken });
    await expect(handleImportBundle(afps, scope, ctx.user.id)).rejects.toThrow();
  });

  it("preserves the optional INTEGRATION.md companion as package content", async () => {
    const doc = "# Gmail integration\n\nAgent-facing docs for the LLM.";
    const afps = buildIntegrationAfps({
      manifest: validManifest(),
      integrationDoc: doc,
    });
    const result = await handleImportBundle(afps, scope, ctx.user.id);
    expect(result.imported[0]!.status).toBe("inserted");

    const [row] = await db
      .select({ draftContent: packages.draftContent })
      .from(packages)
      .where(eq(packages.id, "@official/gmail"));
    expect(row!.draftContent).toBe(doc);
  });
});
