// SPDX-License-Identifier: Apache-2.0

/**
 * A `local` integration carries its MCP server payload in its own archive.
 *
 *   1. PUBLISH — an imported draft publishes its payload; a draft whose entry point file is
 *      absent from the stored files is refused.
 *   2. REFUSALS — an archive missing its entry point is rejected before any write.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync, unzipSync } from "fflate";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { localIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { uploadPackageFiles } from "../../../src/services/package-items/storage.ts";
import { downloadVersionZip } from "../../../src/services/package-storage.ts";
import { packages, packageVersions } from "@appstrate/db/schema";

const app = getTestApp();

const ID = "@pkgorg/local-server-integration";
const ENTRY = "server/index.ts";
const SERVER_SOURCE = "// mcp server entry stub\n";

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function manifestFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...localIntegrationManifest({
      name: ID,
      version: "1.0.0",
      server: { entryPoint: ENTRY },
      auths: { api: { type: "api_key" } },
    }),
    ...overrides,
  } as Record<string, unknown>;
}

function archive(manifest: Record<string, unknown>, files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = { "manifest.json": enc(JSON.stringify(manifest)) };
  for (const [path, text] of Object.entries(files)) entries[path] = enc(text);
  return zipSync(entries as unknown as Parameters<typeof zipSync>[0]);
}

describe("local integration with a server payload", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "pkgorg" });
  });

  async function importArchive(bytes: Uint8Array, name = "server.afps"): Promise<Response> {
    const form = new FormData();
    form.append("file", new Blob([bytes]), name);
    return await app.request("/api/packages/import", {
      method: "POST",
      body: form,
      headers: authHeaders(ctx),
    });
  }

  async function importExecutable(): Promise<void> {
    const res = await importArchive(archive(manifestFor(), { [ENTRY]: SERVER_SOURCE }));
    expect(res.status).toBe(201);
  }

  it("publishes a new version from the draft, payload included", async () => {
    await importExecutable();
    const [row] = await db
      .select({ lockVersion: packages.lockVersion })
      .from(packages)
      .where(eq(packages.id, ID))
      .limit(1);
    expect(row).toBeDefined();
    const publish = await app.request(`/api/packages/integrations/${ID}/versions`, {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ version: "1.0.1" }),
    });
    expect(publish.status).toBe(201);
    const [ver] = await db
      .select({ integrity: packageVersions.integrity })
      .from(packageVersions)
      .where(eq(packageVersions.packageId, ID))
      .orderBy(packageVersions.createdAt);
    expect(ver).toBeDefined();
    const zip = await downloadVersionZip(ID, "1.0.1");
    expect(new TextDecoder().decode(unzipSync(new Uint8Array(zip!))[ENTRY])).toBe(SERVER_SOURCE);
  });

  it("refuses to publish a draft whose entry point is absent from the stored files", async () => {
    const manifest = manifestFor();
    await seedPackage({
      id: ID,
      orgId: ctx.orgId,
      type: "integration",
      createdBy: ctx.user.id,
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: manifest,
    });
    await uploadPackageFiles("integrations", ctx.orgId, ID, {
      "manifest.json": enc(JSON.stringify(manifest, null, 2)),
    });

    const res = await app.request(`/api/packages/integrations/${ID}/versions`, {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string; param?: string };
    expect(body.param).toBe("manifest.source.server.entry_point");
    expect(body.detail).toContain(ENTRY);
    expect(await db.select({ id: packageVersions.id }).from(packageVersions)).toEqual([]);
  });

  it("refuses an archive whose entry point file is missing", async () => {
    const res = await importArchive(archive(manifestFor(), { "other.ts": SERVER_SOURCE }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(ENTRY);
    expect(await db.select({ id: packages.id }).from(packages)).toEqual([]);
  });
});
