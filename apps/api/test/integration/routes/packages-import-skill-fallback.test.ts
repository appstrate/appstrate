// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/packages/import` — which bytes each import path publishes.
 *
 * A bare skill ZIP (`SKILL.md`, no `manifest.json`) gets its manifest
 * synthesized from the frontmatter, so the archive must be rebuilt before it is
 * published; readers of a published artifact take the manifest from the archive,
 * not from the DB row. Every other import must publish the upload untouched.
 *
 * Both halves assert on the PUBLISHED artifact through `DbPackageCatalog` — the
 * reader the run and export paths use — not on the parse result.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { zipSync } from "fflate";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { packageVersions } from "@appstrate/db/schema";
import { computeIntegrity } from "@appstrate/core/integrity";
import { formatPackageIdentity } from "@appstrate/afps-runtime/bundle";
import { DbPackageCatalog } from "../../../src/services/run-launcher/db-package-catalog.ts";
import { downloadVersionZip } from "../../../src/services/package-storage.ts";

const app = getTestApp();

const enc = (s: string) => new TextEncoder().encode(s);

const SKILL_MD = "---\nname: my-skill\ndescription: A test skill.\n---\n\nBody.";

async function importFile(ctx: TestContext, bytes: Uint8Array, filename: string) {
  const formData = new FormData();
  formData.append("file", new File([bytes], filename));
  return app.request("/api/packages/import", {
    method: "POST",
    headers: authHeaders(ctx),
    body: formData,
  });
}

/** The single published version row for `packageId`. */
async function onlyVersion(packageId: string) {
  const rows = await db
    .select()
    .from(packageVersions)
    .where(eq(packageVersions.packageId, packageId));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("POST /api/packages/import — published artifact bytes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "fallbackorg" });
  });

  it("publishes a reconstructed, catalog-readable artifact for a skill-only ZIP", async () => {
    const upload = new Uint8Array(zipSync({ "SKILL.md": enc(SKILL_MD) }));
    const res = await importFile(ctx, upload, "my-skill.zip");
    expect(res.status).toBe(201);

    const packageId = `@${ctx.org.slug}/my-skill`;
    expect(await res.json()).toMatchObject({ packageId, version: "1.0.0", type: "skill" });

    // Not the upload: those bytes declare no manifest.
    const row = await onlyVersion(packageId);
    expect(row.integrity).not.toBe(computeIntegrity(upload));
    // `downloadVersionZip` refuses bytes that do not hash to the recorded
    // integrity, so a non-null return proves row and object agree.
    expect(await downloadVersionZip(packageId, row.version, row.integrity)).not.toBeNull();

    const pkg = await new DbPackageCatalog({ orgId: ctx.orgId }).fetch(
      formatPackageIdentity(packageId as `@${string}/${string}`, "1.0.0"),
    );
    expect(pkg.manifest).toMatchObject({ name: packageId, version: "1.0.0", type: "skill" });
    // Reconstruction adds the manifest; it does not rewrite the payload.
    expect(new TextDecoder().decode(pkg.files.get("SKILL.md")!)).toBe(SKILL_MD);
  });

  it("publishes an ordinary AFPS upload byte-identically", async () => {
    const packageId = "@fallbackorg/authored-skill";
    const upload = new Uint8Array(
      zipSync({
        "manifest.json": enc(
          JSON.stringify({
            name: packageId,
            version: "2.1.0",
            type: "skill",
            schema_version: "0.1",
            display_name: "Authored Skill",
          }),
        ),
        "SKILL.md": enc("---\nname: authored-skill\n---\n\nBody."),
        // A detached signature is the byte that must not be rewritten: any
        // re-zip would invalidate it.
        "SIGNATURE.jws": enc("detached-signature-placeholder"),
      }),
    );

    expect((await importFile(ctx, upload, "authored.afps")).status).toBe(201);

    const row = await onlyVersion(packageId);
    expect(row.integrity).toBe(computeIntegrity(upload));
    expect(
      new Uint8Array((await downloadVersionZip(packageId, row.version, row.integrity))!),
    ).toEqual(upload);

    const pkg = await new DbPackageCatalog({ orgId: ctx.orgId }).fetch(
      formatPackageIdentity(packageId as `@${string}/${string}`, "2.1.0"),
    );
    expect(pkg.files.has("SIGNATURE.jws")).toBe(true);
  });
});
