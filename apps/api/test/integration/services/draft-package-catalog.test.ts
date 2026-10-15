// SPDX-License-Identifier: Apache-2.0

/**
 * {@link DraftPackageCatalog} against a real DB + storage: an integration
 * draft is a bundle member whose files equal what the file explorer shows
 * (`applyDraftOverlay`), and skill drafts are served as stored.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { BundleError } from "@appstrate/afps-runtime/bundle";
import { truncateAll } from "../../helpers/db.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { apiIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { uploadPackageFiles } from "../../../src/services/package-items/storage.ts";
import { DraftPackageCatalog } from "../../../src/services/run-launcher/draft-package-catalog.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const INTEGRATION_ID: `@${string}/${string}` = "@draftcat/int";

describe("DraftPackageCatalog", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "draftcat" });
  });

  async function seedIntegrationDraft(draftContent: string) {
    const id = INTEGRATION_ID;
    const manifest = {
      ...apiIntegrationManifest({ name: id, auths: { api_key: { type: "api_key" } } }),
      version: "1.4.0",
    };
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "integration",
      createdBy: ctx.user.id,
      draftManifest: manifest,
      draftContent,
    });
    // The stored ZIP lags the DB columns: stale doc + stale manifest.
    await uploadPackageFiles("integrations", ctx.orgId, id, {
      "manifest.json": encoder.encode(JSON.stringify({ ...manifest, version: "0.0.1" })),
      "INTEGRATION.md": encoder.encode("# Stale doc"),
      "assets/notes.txt": encoder.encode("annex"),
    });
    return { id, manifest };
  }

  it("serves an integration draft with INTEGRATION.md from draft_content and the draft manifest", async () => {
    const { id, manifest } = await seedIntegrationDraft("# Fresh doc\n\nUse the API.");
    const catalog = new DraftPackageCatalog({ orgId: ctx.orgId });

    const resolved = await catalog.resolve(id, "^1.0.0");
    expect(resolved?.identity).toBe(`${id}@1.4.0`);

    const pkg = await catalog.fetch(resolved!.identity);
    expect(decoder.decode(pkg.files.get("INTEGRATION.md")!)).toBe("# Fresh doc\n\nUse the API.");
    expect(JSON.parse(decoder.decode(pkg.files.get("manifest.json")!))).toEqual(manifest);
    expect(decoder.decode(pkg.files.get("assets/notes.txt")!)).toBe("annex");
    expect(pkg.manifest).toEqual(manifest);
  });

  it("keeps the stored INTEGRATION.md when draft_content is only the manifest-text fallback", async () => {
    const id = INTEGRATION_ID;
    const manifestText = JSON.stringify(
      apiIntegrationManifest({ name: id, auths: { api_key: { type: "api_key" } } }),
    );
    await seedIntegrationDraft(manifestText);
    const catalog = new DraftPackageCatalog({ orgId: ctx.orgId });

    const resolved = await catalog.resolve(id, "*");
    const pkg = await catalog.fetch(resolved!.identity);
    expect(decoder.decode(pkg.files.get("INTEGRATION.md")!)).toBe("# Stale doc");
  });

  it("serves a skill draft as stored", async () => {
    const id = "@draftcat/skill";
    const manifest = { name: id, version: "0.2.0", type: "skill", description: "A skill" };
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "skill",
      createdBy: ctx.user.id,
      draftManifest: manifest,
      draftContent: "---\nname: skill\ndescription: column\n---\n",
    });
    const stored = "---\nname: skill\ndescription: stored\n---\n\nBody.";
    await uploadPackageFiles("skills", ctx.orgId, id, { "SKILL.md": encoder.encode(stored) });
    const catalog = new DraftPackageCatalog({ orgId: ctx.orgId });

    const resolved = await catalog.resolve(id, "*");
    expect(resolved?.identity).toBe(`${id}@0.2.0`);
    const pkg = await catalog.fetch(resolved!.identity);
    expect(decoder.decode(pkg.files.get("SKILL.md")!)).toBe(stored);
    expect(JSON.parse(decoder.decode(pkg.files.get("manifest.json")!))).toEqual(manifest);
  });

  it("refuses a draft type that is not a bundle member", async () => {
    const id = "@draftcat/agent";
    await seedPackage({ id, orgId: ctx.orgId, createdBy: ctx.user.id });
    const catalog = new DraftPackageCatalog({ orgId: ctx.orgId });

    const resolved = await catalog.resolve(id, "*");
    const err = await catalog.fetch(resolved!.identity).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BundleError);
    expect((err as BundleError).code).toBe("BUNDLE_JSON_INVALID");
  });
});
