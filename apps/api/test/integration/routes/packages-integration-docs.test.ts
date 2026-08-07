// SPDX-License-Identifier: Apache-2.0

/**
 * `packages.draft_content` is OVERLOADED for an integration: `parsePackageZip`
 * stores the bundle's `INTEGRATION.md` when it ships one (AFPS §3.5, an
 * OPTIONAL companion) and the MANIFEST TEXT when it does not, with no
 * discriminator on the column.
 *
 * Two write paths produce the manifest shape unconditionally — the SPA editor
 * (`toWireBody` sends `content: JSON.stringify(manifest)` on every save of
 * every integration, and the Edit affordance is gated on `isMutable` alone, so
 * a save with no edit at all is enough) and version restore (which used to read
 * the version ZIP's `manifest.json`). Either one used to overwrite a real
 * `INTEGRATION.md`, with two consequences:
 *
 *   (a) the integration silently stopped contributing its agent-facing
 *       documentation to EVERY agent's platform prompt, because
 *       `fetchIntegrationPromptDocs` rejects a manifest-shaped column; and
 *   (b) the file explorer served manifest JSON under the name `INTEGRATION.md`
 *       — the entry it pre-selects for an integration — because the real file
 *       was still in storage for the draft overlay to land on.
 *
 * These cases pin the column's meaning end to end: through the update route,
 * through restore, and back out of both readers.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { packages, packageDistTags } from "@appstrate/db/schema";
import { zipArtifact } from "@appstrate/core/zip";
import { computeIntegrity } from "@appstrate/core/integrity";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage, seedPackageVersion } from "../../helpers/seed.ts";
import {
  uploadPackageFiles,
  downloadPackageFiles,
} from "../../../src/services/package-items/storage.ts";
import { uploadPackageZip } from "../../../src/services/package-storage.ts";
import { fetchIntegrationPromptDocs } from "../../../src/services/integration-service.ts";

const app = getTestApp();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DOC = "# Gmail\n\nAsk for a label before listing threads.\n";

function integrationManifest(id: string, version = "1.0.0"): Record<string, unknown> {
  return {
    name: id,
    version,
    type: "integration",
    schema_version: "0.1",
    display_name: "Docs Integration",
    description: "A remote HTTP MCP integration",
    source: {
      kind: "remote",
      remote: { url: "https://example.com/mcp/v1", transport: "streamable-http" },
    },
    auths: {
      primary: {
        type: "api_key",
        authorized_uris: ["https://example.com/**"],
        credentials: {
          schema: {
            type: "object",
            required: ["api_key"],
            properties: { api_key: { type: "string" } },
          },
        },
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.api_key}",
          },
        },
      },
    },
  };
}

interface FileEntry {
  path: string;
  size: number;
  media_kind: "text" | "binary";
  inline?: string;
}

async function listFiles(ctx: TestContext, id: string): Promise<FileEntry[]> {
  const res = await app.request(`/api/packages/${id}/files`, { headers: authHeaders(ctx) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { entries: FileEntry[] };
  return body.entries;
}

async function lockVersionOf(ctx: TestContext, id: string): Promise<number> {
  const res = await app.request(`/api/packages/integrations/${id}`, { headers: authHeaders(ctx) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { lock_version: number }).lock_version;
}

/** The exact body `IntegrationEditorInner.toWireBody` sends on every save. */
async function saveThroughEditor(
  ctx: TestContext,
  id: string,
  manifest: Record<string, unknown>,
): Promise<Response> {
  return app.request(`/api/packages/integrations/${id}`, {
    method: "PUT",
    headers: authHeaders(ctx, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      manifest,
      content: JSON.stringify(manifest, null, 2),
      lock_version: await lockVersionOf(ctx, id),
    }),
  });
}

async function draftContentOf(id: string): Promise<string | null> {
  const [row] = await db
    .select({ draftContent: packages.draftContent })
    .from(packages)
    .where(eq(packages.id, id))
    .limit(1);
  return row!.draftContent;
}

async function storedFile(orgId: string, id: string, path: string): Promise<string | undefined> {
  const files = await downloadPackageFiles("integrations", orgId, id);
  const bytes = files?.[path];
  return bytes ? decoder.decode(bytes) : undefined;
}

describe("integration INTEGRATION.md survives the manifest-shaped write paths", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "intdocs" });
  });

  // ─── The reported repro: import a documented integration, press Save ───────

  describe("an integration that ships an INTEGRATION.md", () => {
    const id = "@intdocs/documented";

    beforeEach(async () => {
      // Post-import state: `parsePackageZip` put the doc in the column, and
      // storage holds the real companion alongside the manifest.
      await seedPackage({
        id,
        orgId: ctx.orgId,
        type: "integration",
        draftManifest: integrationManifest(id),
        draftContent: DOC,
      });
      await seedInstalledPackage(ctx.defaultAppId, id);
      await uploadPackageFiles("integrations", ctx.orgId, id, {
        "manifest.json": encoder.encode(JSON.stringify(integrationManifest(id), null, 2)),
        "INTEGRATION.md": encoder.encode(DOC),
      });
    });

    it("keeps its docs in draft_content across an editor save", async () => {
      const res = await saveThroughEditor(ctx, id, integrationManifest(id, "1.1.0"));
      expect(res.status).toBe(200);

      expect(await draftContentOf(id)).toBe(DOC);
    });

    it("still serves the markdown — not manifest JSON — from the file explorer", async () => {
      expect((await saveThroughEditor(ctx, id, integrationManifest(id, "1.1.0"))).status).toBe(200);

      const doc = (await listFiles(ctx, id)).find((e) => e.path === "INTEGRATION.md");
      expect(doc).toBeDefined();
      expect(doc!.inline).toBe(DOC);
      // The failure this pins: the explorer PRE-SELECTS this entry, so the
      // regression showed the package's own manifest as its documentation.
      expect(doc!.inline!.trimStart().startsWith("{")).toBe(false);
    });

    it("keeps feeding the platform prompt its agent-facing docs after a save", async () => {
      expect((await saveThroughEditor(ctx, id, integrationManifest(id, "1.1.0"))).status).toBe(200);

      const [entry] = await fetchIntegrationPromptDocs([id]);
      expect(entry).toBeDefined();
      expect(entry!.doc).toBe(DOC);
    });

    it("still writes the editor's manifest to the stored manifest.json", async () => {
      // The DB column is guarded; the storage sink is NOT. `manifest.json` is
      // where an integration editor's `content` legitimately belongs, and
      // nothing about protecting the docs may strand it.
      const manifest = integrationManifest(id, "2.0.0");
      expect((await saveThroughEditor(ctx, id, manifest)).status).toBe(200);

      const stored = await storedFile(ctx.orgId, id, "manifest.json");
      expect(stored).toBeDefined();
      expect(JSON.parse(stored!)).toMatchObject({ version: "2.0.0", type: "integration" });
      expect(await storedFile(ctx.orgId, id, "INTEGRATION.md")).toBe(DOC);
    });

    it("does not let a manifest-only PUT write the docs into manifest.json", async () => {
      // `content` is optional on the update body and falls back to the stored
      // `draft_content` — which for a documented integration is its
      // INTEGRATION.md. Echoing that into `rcfg.storageFileName()` would
      // replace the package's manifest with its documentation.
      const res = await app.request(`/api/packages/integrations/${id}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: integrationManifest(id, "3.0.0"),
          lock_version: await lockVersionOf(ctx, id),
        }),
      });
      expect(res.status).toBe(200);

      const stored = await storedFile(ctx.orgId, id, "manifest.json");
      expect(JSON.parse(stored!)).toMatchObject({ version: "3.0.0", type: "integration" });
      expect(await draftContentOf(id)).toBe(DOC);
    });
  });

  // ─── The negative: no companion, so the fallback must stay live ────────────

  describe("an integration that ships no INTEGRATION.md", () => {
    const id = "@intdocs/bare";

    beforeEach(async () => {
      await seedPackage({
        id,
        orgId: ctx.orgId,
        type: "integration",
        draftManifest: integrationManifest(id),
        draftContent: JSON.stringify(integrationManifest(id), null, 2),
      });
      await seedInstalledPackage(ctx.defaultAppId, id);
      await uploadPackageFiles("integrations", ctx.orgId, id, {
        "manifest.json": encoder.encode(JSON.stringify(integrationManifest(id), null, 2)),
        "server/index.js": encoder.encode("export default 1;"),
      });
    });

    it("gains no phantom INTEGRATION.md in the explorer after a save", async () => {
      expect((await saveThroughEditor(ctx, id, integrationManifest(id, "1.1.0"))).status).toBe(200);

      const paths = (await listFiles(ctx, id)).map((e) => e.path);
      expect(paths).toEqual(["manifest.json", "server/index.js"]);
    });

    it("REFRESHES the manifest-text fallback rather than freezing a stale copy", async () => {
      expect((await saveThroughEditor(ctx, id, integrationManifest(id, "4.2.0"))).status).toBe(200);

      const content = await draftContentOf(id);
      expect(JSON.parse(content!)).toMatchObject({ version: "4.2.0" });
    });

    it("REFRESHES the manifest-text fallback on a manifest-only PUT", async () => {
      const res = await app.request(`/api/packages/integrations/${id}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          manifest: integrationManifest(id, "4.3.0"),
          lock_version: await lockVersionOf(ctx, id),
        }),
      });
      expect(res.status).toBe(200);

      const response = (await res.json()) as { content: string };
      expect(JSON.parse(response.content)).toMatchObject({ version: "4.3.0" });

      const content = await draftContentOf(id);
      expect(JSON.parse(content!)).toMatchObject({ version: "4.3.0" });
      expect(JSON.parse((await storedFile(ctx.orgId, id, "manifest.json"))!)).toMatchObject({
        version: "4.3.0",
      });
    });

    it("reports no prompt doc — a manifest copy is not documentation", async () => {
      expect((await saveThroughEditor(ctx, id, integrationManifest(id, "1.1.0"))).status).toBe(200);

      const [entry] = await fetchIntegrationPromptDocs([id]);
      expect(entry!.doc).toBeUndefined();
      expect(entry!.description).toBe("A remote HTTP MCP integration");
    });
  });

  // ─── The second door: version restore ─────────────────────────────────────

  describe("restoring a published version", () => {
    const id = "@intdocs/restored";
    const VERSIONED_DOC = "# Published docs\n\nv1 behaviour.\n";

    beforeEach(async () => {
      await seedPackage({
        id,
        orgId: ctx.orgId,
        type: "integration",
        draftManifest: integrationManifest(id, "2.0.0"),
        draftContent: "# Draft docs, edited since publish\n",
      });
      await seedInstalledPackage(ctx.defaultAppId, id);

      const zip = zipArtifact(
        {
          "manifest.json": encoder.encode(JSON.stringify(integrationManifest(id), null, 2)),
          "INTEGRATION.md": encoder.encode(VERSIONED_DOC),
        },
        6,
      );
      await uploadPackageZip(id, "1.0.0", zip);
      const row = await seedPackageVersion({
        packageId: id,
        version: "1.0.0",
        manifest: integrationManifest(id),
        integrity: computeIntegrity(new Uint8Array(zip)),
        artifactSize: zip.byteLength,
      });
      await db.insert(packageDistTags).values({ packageId: id, tag: "latest", versionId: row.id });
    });

    it("restores the version's INTEGRATION.md into draft_content, not its manifest", async () => {
      // `draft_content` mirrors the archive's CONTENT ENTRY, while
      // `rcfg.storageFileName()` for an integration is `manifest.json` — the
      // two names diverge for exactly this type, and reading the wrong one
      // restored a manifest copy over the docs.
      const res = await app.request(`/api/packages/integrations/${id}/versions/1.0.0/restore`, {
        method: "POST",
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      expect(await draftContentOf(id)).toBe(VERSIONED_DOC);
      const [entry] = await fetchIntegrationPromptDocs([id]);
      expect(entry!.doc).toBe(VERSIONED_DOC);
      expect((await listFiles(ctx, id)).find((e) => e.path === "INTEGRATION.md")!.inline).toBe(
        VERSIONED_DOC,
      );
    });
  });

  // ─── Already-corrupted rows: no write-path fix can reach them ──────────────

  it("serves the stored INTEGRATION.md for a row already holding a manifest copy", async () => {
    // Written by a build that predates the fix: the column is manifest JSON
    // while the real doc sits untouched in storage. No backfill is being
    // shipped, so the explorer has to decline the overlay and show the file.
    const id = "@intdocs/legacy-corrupted";
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "integration",
      draftManifest: integrationManifest(id),
      draftContent: JSON.stringify(integrationManifest(id), null, 2),
    });
    await seedInstalledPackage(ctx.defaultAppId, id);
    await uploadPackageFiles("integrations", ctx.orgId, id, {
      "manifest.json": encoder.encode("{}"),
      "INTEGRATION.md": encoder.encode(DOC),
    });

    const doc = (await listFiles(ctx, id)).find((e) => e.path === "INTEGRATION.md");
    expect(doc!.inline).toBe(DOC);
  });
});
