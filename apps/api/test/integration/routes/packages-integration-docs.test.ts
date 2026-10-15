// SPDX-License-Identifier: Apache-2.0

/**
 * Integration draft content holds either INTEGRATION.md or the manifest when
 * that optional file is absent. Manifest-shaped PUT.content values and restores
 * must preserve real documentation in both `draft_content` and the file explorer.
 */

import { etagVersion, ifMatch } from "../../helpers/etag.ts";
import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { packages, packageDistTags } from "@appstrate/db/schema";
import { zipArtifact } from "@appstrate/core/zip";
import { computeIntegrity } from "@appstrate/core/integrity";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import {
  seedSpacePackage,
  seedPackage,
  seedPackageShare,
  seedPackageVersion,
} from "../../helpers/seed.ts";
import {
  uploadPackageFiles,
  downloadPackageFiles,
} from "../../../src/services/package-items/storage.ts";
import { uploadPackageZip, buildAgentPackage } from "../../../src/services/package-storage.ts";
import { unzipPackageArchive } from "../../../src/services/package-archive.ts";
import { freezeRunSpawnDependencies } from "../../../src/services/run-pipeline.ts";
import { readBundleFromBuffer } from "@appstrate/afps-runtime/bundle";
import type { AgentManifest, LoadedPackage } from "../../../src/types/index.ts";

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
  const body = (await res.json()) as { data: FileEntry[] };
  return body.data;
}

async function lockVersionOf(ctx: TestContext, id: string): Promise<number> {
  const res = await app.request(`/api/packages/integrations/${id}`, { headers: authHeaders(ctx) });
  expect(res.status).toBe(200);
  return etagVersion(res);
}

/** Exercise the public content field with a manifest-shaped value. */
async function saveManifestContent(
  ctx: TestContext,
  id: string,
  manifest: Record<string, unknown>,
): Promise<Response> {
  return app.request(`/api/packages/integrations/${id}`, {
    method: "PATCH",
    headers: authHeaders(ctx, {
      "Content-Type": "application/json",
      ...ifMatch(await lockVersionOf(ctx, id)),
    }),
    body: JSON.stringify({
      manifest,
      content: JSON.stringify(manifest, null, 2),
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
      await seedPackageShare(ctx.defaultSpaceId, id);
      await seedSpacePackage(ctx.defaultSpaceId, id);
      await uploadPackageFiles("integrations", ctx.orgId, id, {
        "manifest.json": encoder.encode(JSON.stringify(integrationManifest(id), null, 2)),
        "INTEGRATION.md": encoder.encode(DOC),
      });
    });

    it("keeps its docs in draft_content across an editor save", async () => {
      const res = await saveManifestContent(ctx, id, integrationManifest(id, "1.1.0"));
      expect(res.status).toBe(200);

      expect(await draftContentOf(id)).toBe(DOC);
    });

    it("still serves the markdown — not manifest JSON — from the file explorer", async () => {
      expect((await saveManifestContent(ctx, id, integrationManifest(id, "1.1.0"))).status).toBe(
        200,
      );

      const doc = (await listFiles(ctx, id)).find((e) => e.path === "INTEGRATION.md");
      expect(doc).toBeDefined();
      expect(doc!.inline).toBe(DOC);
      // The failure this pins: the explorer PRE-SELECTS this entry, so the
      // regression showed the package's own manifest as its documentation.
      expect(doc!.inline!.trimStart().startsWith("{")).toBe(false);
    });

    it("still writes the editor's manifest to the stored manifest.json", async () => {
      // The DB column is guarded; the storage sink is NOT. `manifest.json` is
      // where an integration editor's `content` legitimately belongs, and
      // nothing about protecting the docs may strand it.
      const manifest = integrationManifest(id, "2.0.0");
      expect((await saveManifestContent(ctx, id, manifest)).status).toBe(200);

      const stored = await storedFile(ctx.orgId, id, "manifest.json");
      expect(stored).toBeDefined();
      expect(JSON.parse(stored!)).toMatchObject({ version: "2.0.0", type: "integration" });
      expect(await storedFile(ctx.orgId, id, "INTEGRATION.md")).toBe(DOC);
    });

    it("stores the doc of THIS save, not the previous one, where publish reads it", async () => {
      const next = "# Gmail\n\nList labels first.\n";
      const res = await app.request(`/api/packages/integrations/${id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, {
          "Content-Type": "application/json",
          ...ifMatch(await lockVersionOf(ctx, id)),
        }),
        body: JSON.stringify({ content: next }),
      });
      expect(res.status).toBe(200);

      expect(await draftContentOf(id)).toBe(next);
      expect(await storedFile(ctx.orgId, id, "INTEGRATION.md")).toBe(next);
    });

    it("does not let a manifest-only PUT write the docs into manifest.json", async () => {
      // `content` is optional on the update body and falls back to the stored
      // `draft_content` — which for a documented integration is its
      // INTEGRATION.md. Echoing that into `rcfg.storageFileName()` would
      // replace the package's manifest with its documentation.
      const res = await app.request(`/api/packages/integrations/${id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, {
          "Content-Type": "application/json",
          ...ifMatch(await lockVersionOf(ctx, id)),
        }),
        body: JSON.stringify({
          manifest: integrationManifest(id, "3.0.0"),
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
      await seedPackageShare(ctx.defaultSpaceId, id);
      await seedSpacePackage(ctx.defaultSpaceId, id);
      await uploadPackageFiles("integrations", ctx.orgId, id, {
        "manifest.json": encoder.encode(JSON.stringify(integrationManifest(id), null, 2)),
        "server/index.js": encoder.encode("export default 1;"),
      });
    });

    it("gains no phantom INTEGRATION.md in the explorer after a save", async () => {
      expect((await saveManifestContent(ctx, id, integrationManifest(id, "1.1.0"))).status).toBe(
        200,
      );

      const paths = (await listFiles(ctx, id)).map((e) => e.path);
      expect(paths).toEqual(["manifest.json", "server/index.js"]);
    });

    it("REFRESHES the manifest-text fallback rather than freezing a stale copy", async () => {
      expect((await saveManifestContent(ctx, id, integrationManifest(id, "4.2.0"))).status).toBe(
        200,
      );

      const content = await draftContentOf(id);
      expect(JSON.parse(content!)).toMatchObject({ version: "4.2.0" });
    });

    it("REFRESHES the manifest-text fallback on a manifest-only PUT", async () => {
      const res = await app.request(`/api/packages/integrations/${id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, {
          "Content-Type": "application/json",
          ...ifMatch(await lockVersionOf(ctx, id)),
        }),
        body: JSON.stringify({
          manifest: integrationManifest(id, "4.3.0"),
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
      await seedPackageShare(ctx.defaultSpaceId, id);
      await seedSpacePackage(ctx.defaultSpaceId, id);

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
      expect((await listFiles(ctx, id)).find((e) => e.path === "INTEGRATION.md")!.inline).toBe(
        VERSIONED_DOC,
      );
    });
  });

  // ─── The JSON `content` field: the stored tree publish freezes ─────────────

  describe("an integration documented through the JSON content field", () => {
    const id = "@intdocs/authored";

    async function create(version = "1.0.0"): Promise<Response> {
      return app.request("/api/packages/integrations", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ manifest: integrationManifest(id, version), content: DOC }),
      });
    }

    async function saveContent(content: string, version: string): Promise<Response> {
      return app.request(`/api/packages/integrations/${id}`, {
        method: "PATCH",
        headers: authHeaders(ctx, {
          "Content-Type": "application/json",
          ...ifMatch(await lockVersionOf(ctx, id)),
        }),
        body: JSON.stringify({ manifest: integrationManifest(id, version), content }),
      });
    }

    async function publish(version: string): Promise<void> {
      const res = await app.request(`/api/packages/integrations/${id}/versions`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ version }),
      });
      expect(res.status).toBe(201);
    }

    async function frozenDoc(version: string): Promise<string | undefined> {
      const res = await app.request(`/api/packages/${id}/${version}/download`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const bytes = unzipPackageArchive(new Uint8Array(await res.arrayBuffer()))["INTEGRATION.md"];
      return bytes ? decoder.decode(bytes) : undefined;
    }

    it("stores INTEGRATION.md and freezes it into the version minted at creation", async () => {
      expect((await create()).status).toBe(201);

      expect(await draftContentOf(id)).toBe(DOC);
      expect(await storedFile(ctx.orgId, id, "INTEGRATION.md")).toBe(DOC);
      expect(await frozenDoc("1.0.0")).toBe(DOC);
    });

    it("freezes the doc of the LAST save into a published version", async () => {
      expect((await create()).status).toBe(201);
      const next = "# Gmail\n\nRevised after review.\n";
      expect((await saveContent(next, "1.1.0")).status).toBe(200);

      // The draft overlay hands the save the PREVIOUS column; the stored copy
      // must follow this save, not trail it by one.
      expect(await storedFile(ctx.orgId, id, "INTEGRATION.md")).toBe(next);
      await publish("1.1.0");
      expect(await frozenDoc("1.1.0")).toBe(next);
    });

    it("an emptied content removes the doc from the stored tree and the next version", async () => {
      expect((await create()).status).toBe(201);
      expect((await saveContent("", "1.1.0")).status).toBe(200);

      expect(await draftContentOf(id)).toBe("");
      expect(await storedFile(ctx.orgId, id, "INTEGRATION.md")).toBeUndefined();
      expect((await listFiles(ctx, id)).some((e) => e.path === "INTEGRATION.md")).toBe(false);
      await publish("1.1.0");
      expect(await frozenDoc("1.1.0")).toBeUndefined();
    });

    it("writes no INTEGRATION.md for the manifest-text value the dashboard sends", async () => {
      const manifest = integrationManifest(id);
      const res = await app.request("/api/packages/integrations", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ manifest, content: JSON.stringify(manifest, null, 2) }),
      });
      expect(res.status).toBe(201);

      expect(await storedFile(ctx.orgId, id, "INTEGRATION.md")).toBeUndefined();
      expect(await frozenDoc("1.0.0")).toBeUndefined();
    });

    it("hands the published doc to a run bundle pinning that version", async () => {
      expect((await create()).status).toBe(201);
      const manifest = {
        schema_version: "0.2",
        type: "agent",
        name: "@intdocs/agent",
        version: "1.0.0",
        display_name: "Agent",
        dependencies: { integrations: { [id]: "^1.0.0" } },
        integrations_configuration: { [id]: {} },
      };
      const agent: LoadedPackage = {
        id: manifest.name,
        manifest: manifest as unknown as AgentManifest,
        prompt: "Do the thing.",
        source: "local",
      };

      const integrationVersions = await freezeRunSpawnDependencies({ agent, orgId: ctx.orgId });
      expect(integrationVersions[id]).toEqual({ version: "1.0.0", source: "version" });
      const { zip } = await buildAgentPackage(agent, ctx.orgId, { integrationVersions });
      const member = [...readBundleFromBuffer(new Uint8Array(zip)).packages.values()].find(
        (p) => p.identity === `${id}@1.0.0`,
      );
      expect(member).toBeDefined();
      expect(decoder.decode(member!.files.get("INTEGRATION.md"))).toBe(DOC);
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
    await seedPackageShare(ctx.defaultSpaceId, id);
    await seedSpacePackage(ctx.defaultSpaceId, id);
    await uploadPackageFiles("integrations", ctx.orgId, id, {
      "manifest.json": encoder.encode("{}"),
      "INTEGRATION.md": encoder.encode(DOC),
    });

    const doc = (await listFiles(ctx, id)).find((e) => e.path === "INTEGRATION.md");
    expect(doc!.inline).toBe(DOC);
  });
});
