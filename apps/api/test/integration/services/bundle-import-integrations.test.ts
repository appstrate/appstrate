// SPDX-License-Identifier: Apache-2.0

/**
 * Bundle-import end-to-end for `type: "integration"` packages
 * (INTEGRATIONS_PROPOSAL Phase 1.0 deliverable).
 *
 * Validates that a raw `.afps` carrying an integration manifest can be
 * read, validated, and persisted through the same pipeline used by
 * agents/skills/integrations — `handleImportBundle` → `parsePackageZip`
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
import { apiIntegrationManifest, httpHeaderDelivery } from "../../helpers/integration-manifests.ts";

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
  // AFPS serverless `api`-source integration (no separate mcp-server to
  // bundle), so a bundle-of-one imports cleanly.
  return {
    ...(apiIntegrationManifest({
      name: "@official/gmail",
      displayName: "Gmail",
      auths: {
        api: {
          type: "api_key",
          authorizedUris: ["https://gmail.googleapis.com/**"],
          delivery: httpHeaderDelivery({
            name: "Authorization",
            prefix: "Bearer ",
            field: "api_key",
          }),
        },
      },
    }) as unknown as Record<string, unknown>),
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

    expect(result.root_package_id).toBe("@official/gmail");
    expect(result.root_version).toBe("1.0.0");
    expect(result.imported.length).toBe(1);
    expect(result.imported[0]!.status).toBe("inserted");
    expect(result.imported[0]!.version_id).toBeGreaterThan(0);

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
    expect(summary!.manifest.display_name).toBe("Gmail");

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

  it("rejects an .afps whose integration manifest declares no auth method (AFPS §7)", async () => {
    // AFPS requires an integration to declare ≥1 auth method; an empty
    // `auths` map fails schema validation at bundle read time.
    const broken = validManifest({ auths: {} });
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
