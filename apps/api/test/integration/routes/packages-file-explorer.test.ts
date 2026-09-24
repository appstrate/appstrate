// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only package file explorer:
 *   GET /api/packages/{scope}/{name}/files
 *   GET /api/packages/{scope}/{name}/files/content
 *
 * The invariants worth locking down are the ones a naive implementation gets
 * wrong: the draft is the DB overlaid on the stored ZIP (not the ZIP), a
 * published version is the pinned bytes (not the draft), the access gate is
 * the space install, and the bytes route can never be tricked into
 * serving something a browser will execute.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { packages, packageDistTags, packageVersions } from "@appstrate/db/schema";
import { computeIntegrity } from "@appstrate/core/integrity";
import { PACKAGE_FILE_INLINE_MAX_BYTES } from "@appstrate/core/package-files";
import { zipArtifact, PACKAGE_ZIP_MAX_COMPRESSED_BYTES } from "@appstrate/core/zip";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { expectProblem } from "../../helpers/assertions.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedSpacePackage,
  seedPackage,
  seedPackageShare,
  seedPackageVersion,
  seedSpace,
  seedSpaceMember,
} from "../../helpers/seed.ts";
import {
  uploadPackageFiles,
  downloadPackageFiles,
  SYSTEM_STORAGE_NAMESPACE,
} from "../../../src/services/package-items/storage.ts";
import { indexEtag, mutatePackageDraftFiles } from "../../../src/services/package-files.ts";
import { ApiError } from "../../../src/lib/errors.ts";
import { uploadPackageZip, buildMinimalZip } from "../../../src/services/package-storage.ts";
import { insertShadowPackage } from "../../../src/services/inline-run.ts";
import { isPackageActiveHere } from "../../../src/services/space-packages.ts";
import type { AgentManifest } from "../../../src/types/index.ts";

const app = getTestApp();
const encoder = new TextEncoder();

interface FileEntry {
  path: string;
  size: number;
  media_kind: "text" | "binary";
  inline?: string;
}

function manifestFor(id: string, version = "1.0.0"): Record<string, unknown> {
  return {
    name: id,
    display_name: "Explorer Agent",
    version,
    type: "agent",
    description: "File explorer fixture",
    schema_version: "0.1",
  };
}

async function listFiles(
  ctx: TestContext,
  id: string,
  query = "",
): Promise<{ res: Response; entries: FileEntry[] }> {
  const res = await app.request(`/api/packages/${id}/files${query}`, { headers: authHeaders(ctx) });
  if (res.status !== 200) return { res, entries: [] };
  const body = (await res.clone().json()) as { entries: FileEntry[] };
  return { res, entries: body.entries };
}

async function fetchContent(
  ctx: TestContext,
  id: string,
  path: string,
  extra = "",
): Promise<Response> {
  return app.request(`/api/packages/${id}/files/content?path=${encodeURIComponent(path)}${extra}`, {
    headers: authHeaders(ctx),
  });
}

describe("package file explorer", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "fexp" });
  });

  // ─── Draft reads ───────────────────────────────────────────────────────────

  describe("draft snapshot", () => {
    const id = "@fexp/draft-agent";

    beforeEach(async () => {
      await seedPackage({
        id,
        orgId: ctx.orgId,
        type: "agent",
        draftManifest: manifestFor(id),
        draftContent: "draft prompt from DB",
      });
      await seedPackageShare(ctx.defaultSpaceId, id);
      await seedSpacePackage(ctx.defaultSpaceId, id);
    });

    it("lists ZIP entries alongside the DB-authoritative files", async () => {
      await uploadPackageFiles("agents", ctx.orgId, id, {
        "manifest.json": encoder.encode(JSON.stringify(manifestFor(id))),
        "prompt.md": encoder.encode("STALE prompt from the ZIP"),
        "docs/notes.md": encoder.encode("# notes"),
      });

      const { res, entries } = await listFiles(ctx, id);
      expect(res.status).toBe(200);
      expect(entries.map((e) => e.path)).toEqual(["docs/notes.md", "manifest.json", "prompt.md"]);

      // The DB draft columns WIN over the stored ZIP — the editor writes the
      // row first and re-uploads afterwards, so the ZIP is allowed to lag.
      const prompt = entries.find((e) => e.path === "prompt.md")!;
      expect(prompt.inline).toBe("draft prompt from DB");
      expect(await (await fetchContent(ctx, id, "prompt.md")).text()).toBe("draft prompt from DB");

      // Pretty-printed, so it is not byte-identical to what the ZIP holds.
      const manifest = entries.find((e) => e.path === "manifest.json")!;
      expect(JSON.parse(manifest.inline!)).toEqual(manifestFor(id));
      expect(manifest.inline).toContain("\n  ");

      // Non-overlaid ZIP entries pass through untouched.
      expect(entries.find((e) => e.path === "docs/notes.md")!.inline).toBe("# notes");
    });

    it("reflects a later draft write without touching storage", async () => {
      await uploadPackageFiles("agents", ctx.orgId, id, {
        "prompt.md": encoder.encode("STALE prompt from the ZIP"),
      });
      const before = await listFiles(ctx, id);

      await db
        .update(packages)
        .set({ draftContent: "rewritten prompt", draftManifest: manifestFor(id, "1.2.3") })
        .where(eq(packages.id, id));

      const after = await listFiles(ctx, id);
      expect(after.entries.find((e) => e.path === "prompt.md")!.inline).toBe("rewritten prompt");
      expect(
        JSON.parse(after.entries.find((e) => e.path === "manifest.json")!.inline!),
      ).toMatchObject({ version: "1.2.3" });
      // A content-addressed ETag must move with the content, not with the ZIP.
      expect(after.res.headers.get("ETag")).not.toBe(before.res.headers.get("ETag"));
    });

    it("still lists the DB-backed files when no ZIP was ever stored", async () => {
      const { res, entries } = await listFiles(ctx, id);
      expect(res.status).toBe(200);
      expect(entries.map((e) => e.path)).toEqual(["manifest.json", "prompt.md"]);
      expect(entries.find((e) => e.path === "prompt.md")!.inline).toBe("draft prompt from DB");
    });

    it("serves a draft with `private, no-cache` and a strong ETag", async () => {
      const { res } = await listFiles(ctx, id);
      expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
      expect(res.headers.get("ETag")).toMatch(/^"i-pd-[0-9a-f]{64}"$/);
    });

    it("overlays a skill's draft_content onto SKILL.md", async () => {
      const skillId = "@fexp/a-skill";
      await seedPackage({
        id: skillId,
        homeSpaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        type: "skill",
        draftManifest: { ...manifestFor(skillId), type: "skill" },
        draftContent: "---\nname: a-skill\ndescription: A skill.\n---\nbody",
      });
      await seedSpacePackage(ctx.defaultSpaceId, skillId);

      const { entries } = await listFiles(ctx, skillId);
      expect(entries.map((e) => e.path)).toEqual(["SKILL.md", "manifest.json"]);
      expect(entries.find((e) => e.path === "SKILL.md")!.inline).toBe(
        "---\nname: a-skill\ndescription: A skill.\n---\nbody",
      );
    });
  });

  // ─── Per-type draft_content targets ────────────────────────────────────────
  //
  // `draft_content` is populated by `parsePackageZip` (packages/core/src/zip.ts)
  // and holds a DIFFERENT file per type — prompt.md, SKILL.md, INTEGRATION.md,
  // or (mcp-server) a redundant copy of the manifest. Overlaying it onto the
  // wrong entry would either erase the manifest or invent a file.

  describe("draft_content overlay targets", () => {
    it("overlays an integration's draft_content onto INTEGRATION.md when the ZIP has one", async () => {
      const intId = "@fexp/documented-integration";
      await seedPackage({
        id: intId,
        homeSpaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        type: "integration",
        draftManifest: { ...manifestFor(intId), type: "integration" },
        draftContent: "# Updated integration docs",
      });
      await seedSpacePackage(ctx.defaultSpaceId, intId);
      await uploadPackageFiles("integrations", ctx.orgId, intId, {
        "manifest.json": encoder.encode("{}"),
        "INTEGRATION.md": encoder.encode("# STALE docs from the ZIP"),
      });

      const { entries } = await listFiles(ctx, intId);
      expect(entries.map((e) => e.path)).toEqual(["INTEGRATION.md", "manifest.json"]);
      expect(entries.find((e) => e.path === "INTEGRATION.md")!.inline).toBe(
        "# Updated integration docs",
      );
      // The manifest overlay still wins over the ZIP's `{}`.
      expect(JSON.parse(entries.find((e) => e.path === "manifest.json")!.inline!)).toMatchObject({
        type: "integration",
      });
    });

    it("does not invent an INTEGRATION.md when the package has none", async () => {
      // With no INTEGRATION.md in the bundle, `zip.ts` stores the MANIFEST TEXT
      // in draft_content. Materializing that as INTEGRATION.md would show a
      // file the package does not contain.
      const intId = "@fexp/bare-integration";
      const manifest = { ...manifestFor(intId), type: "integration" };
      await seedPackage({
        id: intId,
        homeSpaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        type: "integration",
        draftManifest: manifest,
        draftContent: JSON.stringify(manifest),
      });
      await seedSpacePackage(ctx.defaultSpaceId, intId);
      await uploadPackageFiles("integrations", ctx.orgId, intId, {
        "manifest.json": encoder.encode(JSON.stringify(manifest)),
        "server/index.js": encoder.encode("export default 1;"),
      });

      const { entries } = await listFiles(ctx, intId);
      expect(entries.map((e) => e.path)).toEqual(["manifest.json", "server/index.js"]);
    });

    it("never materializes an mcp-server's draft_content (it is a manifest copy)", async () => {
      const mcpId = "@fexp/an-mcp-server";
      const manifest = { ...manifestFor(mcpId), type: "mcp-server" };
      await seedPackage({
        id: mcpId,
        homeSpaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        type: "mcp-server",
        draftManifest: manifest,
        draftContent: JSON.stringify(manifest),
      });
      await seedSpacePackage(ctx.defaultSpaceId, mcpId);
      await uploadPackageFiles("mcp-servers", ctx.orgId, mcpId, {
        "manifest.json": encoder.encode("{}"),
        "server/index.js": encoder.encode("export default 1;"),
      });

      const { entries } = await listFiles(ctx, mcpId);
      expect(entries.map((e) => e.path)).toEqual(["manifest.json", "server/index.js"]);
      expect(JSON.parse(entries.find((e) => e.path === "manifest.json")!.inline!)).toMatchObject({
        type: "mcp-server",
      });
    });

    it("keeps an mcp-server's manifest intact with no stored ZIP at all", async () => {
      const mcpId = "@fexp/bare-mcp-server";
      const manifest = { ...manifestFor(mcpId), type: "mcp-server" };
      await seedPackage({
        id: mcpId,
        homeSpaceId: ctx.defaultSpaceId,
        orgId: ctx.orgId,
        type: "mcp-server",
        draftManifest: manifest,
        draftContent: "",
      });
      await seedSpacePackage(ctx.defaultSpaceId, mcpId);

      const { entries } = await listFiles(ctx, mcpId);
      expect(entries.map((e) => e.path)).toEqual(["manifest.json"]);
      expect(JSON.parse(entries[0]!.inline!)).toMatchObject({ type: "mcp-server" });
    });
  });

  // ─── Published versions ────────────────────────────────────────────────────

  describe("published version snapshot", () => {
    const id = "@fexp/versioned-agent";

    beforeEach(async () => {
      await seedPackage({
        id,
        orgId: ctx.orgId,
        type: "agent",
        draftManifest: manifestFor(id, "2.0.0"),
        draftContent: "draft prompt",
      });
      await seedPackageShare(ctx.defaultSpaceId, id);
      await seedSpacePackage(ctx.defaultSpaceId, id);

      const zip = buildMinimalZip(manifestFor(id), "published prompt v1", "prompt.md");
      await uploadPackageZip(id, "1.0.0", zip);
      const row = await seedPackageVersion({
        packageId: id,
        version: "1.0.0",
        manifest: manifestFor(id),
        integrity: computeIntegrity(new Uint8Array(zip)),
        artifactSize: zip.byteLength,
      });
      await db.insert(packageDistTags).values({ packageId: id, tag: "latest", versionId: row.id });
    });

    it("returns exactly the pinned bytes, with no draft overlay", async () => {
      const { res, entries } = await listFiles(ctx, id, "?version=1.0.0");
      expect(res.status).toBe(200);
      expect(entries.find((e) => e.path === "prompt.md")!.inline).toBe("published prompt v1");
      expect(JSON.parse(entries.find((e) => e.path === "manifest.json")!.inline!)).toMatchObject({
        version: "1.0.0",
      });
    });

    it("is unaffected by a later draft write", async () => {
      const before = await listFiles(ctx, id, "?version=1.0.0");

      await db
        .update(packages)
        .set({ draftContent: "totally different", draftManifest: manifestFor(id, "9.9.9") })
        .where(eq(packages.id, id));

      const after = await listFiles(ctx, id, "?version=1.0.0");
      expect(after.entries).toEqual(before.entries);
      expect(after.res.headers.get("ETag")).toBe(before.res.headers.get("ETag"));
      expect(await (await fetchContent(ctx, id, "prompt.md", "&version=1.0.0")).text()).toBe(
        "published prompt v1",
      );
    });

    it("gives an EXACT, non-yanked version pin no fresh window — it would outlive a permission revocation", async () => {
      // Any `max-age` lets the browser serve these RBAC-gated, tenant-scoped
      // bytes with zero server contact, so a revoked `<type>:read`, a removed
      // member or an uninstalled package would keep being answered from cache.
      const { res } = await listFiles(ctx, id, "?version=1.0.0");
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
      expect(res.headers.get("Cache-Control")).not.toContain("max-age");
      expect(res.headers.get("ETag")).toBe(`"i-pv-${(await versionIntegrity(id))!}"`);

      // Same on the route that actually hands over the artifact's bytes.
      const content = await fetchContent(ctx, id, "prompt.md", "&version=1.0.0");
      expect(content.status).toBe(200);
      expect(content.headers.get("Cache-Control")).toBe("private, no-cache");
      expect(content.headers.get("Cache-Control")).not.toContain("max-age");
    });

    it("resolves a dist-tag to the same bytes, under the same policy", async () => {
      // `?version=latest` is a MOVING target on top of everything else: a
      // cached copy would also hide a freshly published 1.1.0.
      const { res, entries } = await listFiles(ctx, id, "?version=latest");
      expect(res.status).toBe(200);
      expect(entries.find((e) => e.path === "prompt.md")!.inline).toBe("published prompt v1");
      expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
      // Same content tag as the exact pin — the selector does not change it.
      expect(res.headers.get("ETag")).toBe(`"i-pv-${(await versionIntegrity(id))!}"`);
    });

    it("resolves a semver range under the same policy", async () => {
      const { res } = await listFiles(ctx, id, "?version=%5E1.0.0");
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    });

    it("never caches a yanked version at all, and flags it with X-Yanked", async () => {
      await db
        .update(packageVersions)
        .set({ yanked: true, yankedReason: "bad release" })
        .where(eq(packageVersions.packageId, id));

      const { res } = await listFiles(ctx, id, "?version=1.0.0");
      expect(res.status).toBe(200);
      // A cached copy could never learn it had been withdrawn.
      expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
      expect(res.headers.get("X-Yanked")).toBe("true");

      const content = await fetchContent(ctx, id, "prompt.md", "&version=1.0.0");
      expect(content.status).toBe(200);
      expect(content.headers.get("X-Yanked")).toBe("true");
    });

    it("omits X-Yanked on a healthy version and on the draft", async () => {
      const { res } = await listFiles(ctx, id, "?version=1.0.0");
      expect(res.headers.get("X-Yanked")).toBeNull();
      const draft = await listFiles(ctx, id);
      expect(draft.res.headers.get("X-Yanked")).toBeNull();
    });

    it("404s an unknown version", async () => {
      const { res } = await listFiles(ctx, id, "?version=7.7.7");
      expect(res.status).toBe(404);
    });

    it("400s an empty version parameter rather than silently reading the draft", async () => {
      const { res } = await listFiles(ctx, id, "?version=");
      expect(res.status).toBe(400);
    });
  });

  // ─── Decompression ceiling ─────────────────────────────────────────────────

  /**
   * The explorer is a READ boundary over bytes the platform already stores, and
   * it must apply the SAME decompressed ceiling the import gate applies. It did
   * not: its draft and version paths used different storage helpers, and either
   * could inherit `unzipArtifact`'s 200 MB generic default. These assertions pin
   * both paths to the package-specific 50 MB ceiling.
   */
  /**
   * Budget for the two cases that build a 54 MB expansion and read it through
   * BOTH routes. The decompression is the measurement, not incidental cost, and
   * a pair of them lands within a few hundred milliseconds of bun's 5 s default
   * — so on a loaded machine the suite went red on timing rather than on
   * behaviour, and the ceiling these cases exist to prove said nothing either
   * way. Generous on purpose: a real regression here is a 422 that stops
   * arriving, which this still catches.
   */
  const CEILING_TEST_TIMEOUT_MS = 30_000;

  describe("decompression ceiling", () => {
    const id = "@fexp/high-ratio-agent";

    /**
     * Build entries that expand to `blockMb * copies` MB.
     *
     * The padding entries all reference the SAME buffer, so a 54 MB expansion
     * costs one 6 MB allocation here — no 50 MB fixture is materialized, and
     * the archive itself stays a few tens of KB because a run of one repeated
     * byte is what deflate compresses best.
     */
    function expandingEntries(blockMb: number, copies: number): Record<string, Uint8Array> {
      const block = new Uint8Array(blockMb * 1024 * 1024);
      const entries: Record<string, Uint8Array> = {
        "manifest.json": encoder.encode(JSON.stringify(manifestFor(id))),
        "prompt.md": encoder.encode("published prompt v1"),
      };
      for (let i = 0; i < copies; i++) entries[`pad-${i}.bin`] = block;
      return entries;
    }

    async function seedVersionExpandingTo(blockMb: number, copies: number): Promise<Buffer> {
      const entries = expandingEntries(blockMb, copies);
      const zip = Buffer.from(zipArtifact(entries, 9));

      await uploadPackageZip(id, "1.0.0", zip);
      await seedPackageVersion({
        packageId: id,
        version: "1.0.0",
        manifest: manifestFor(id),
        integrity: computeIntegrity(new Uint8Array(zip)),
        artifactSize: zip.byteLength,
      });
      return zip;
    }

    beforeEach(async () => {
      await seedPackage({
        id,
        orgId: ctx.orgId,
        type: "agent",
        draftManifest: manifestFor(id),
        draftContent: "draft prompt",
      });
      await seedPackageShare(ctx.defaultSpaceId, id);
      await seedSpacePackage(ctx.defaultSpaceId, id);
    });

    it(
      "refuses a published artifact that expands past the ceiling, on both read routes",
      async () => {
        // 9 x 6 MB = 54 MB decompressed, over the 50 MB ceiling.
        const zip = await seedVersionExpandingTo(6, 9);

        // The archive is well under the COMPRESSED ceiling — which is exactly the
        // point: the compressed size can never bound the expansion, so the
        // decompressed budget is the only thing standing between a stored
        // artifact and an amplification primitive.
        expect(zip.byteLength).toBeLessThan(PACKAGE_ZIP_MAX_COMPRESSED_BYTES);

        const { res } = await listFiles(ctx, id, "?version=1.0.0");
        expect(res.status).toBe(422);
        expect(res.headers.get("Content-Type")).toContain("application/problem+json");
        const problem = (await res.json()) as { code: string; detail: string };
        expect(problem.code).toBe("package_archive_unreadable");
        expect(problem.detail).toContain("50 MB");

        // The single-file route reads through the same snapshot, so it must
        // refuse identically — otherwise the cheaper route stays exploitable.
        const content = await fetchContent(ctx, id, "prompt.md", "&version=1.0.0");
        expect(content.status).toBe(422);
        expect(((await content.json()) as { code: string }).code).toBe(
          "package_archive_unreadable",
        );
        // Two 54 MB decompressions on one request pair: the work IS the subject,
        // so it sits above bun's 5 s default rather than failing on machine load.
      },
      CEILING_TEST_TIMEOUT_MS,
    );

    it(
      "refuses a draft artifact that expands past the ceiling, on both read routes",
      async () => {
        // Drafts use a different storage helper from published versions. Keep
        // this assertion separate so neither path can silently drift to the
        // generic ZIP helper's larger default.
        await uploadPackageFiles("agents", ctx.orgId, id, expandingEntries(6, 9));

        const { res } = await listFiles(ctx, id);
        expect(res.status).toBe(422);
        expect(res.headers.get("Content-Type")).toContain("application/problem+json");
        const problem = (await res.json()) as { code: string; detail: string };
        expect(problem.code).toBe("package_archive_unreadable");
        expect(problem.detail).toContain("50 MB");

        const content = await fetchContent(ctx, id, "prompt.md");
        expect(content.status).toBe(422);
        expect(((await content.json()) as { code: string }).code).toBe(
          "package_archive_unreadable",
        );
      },
      CEILING_TEST_TIMEOUT_MS,
    );

    it("still serves an artifact that stays under the ceiling", async () => {
      // Positive control: without it, a cap that rejected EVERY high-ratio
      // archive — or every archive at all — would pass the test above.
      await seedVersionExpandingTo(6, 1);

      const { res, entries } = await listFiles(ctx, id, "?version=1.0.0");
      expect(res.status).toBe(200);
      expect(entries.find((e) => e.path === "pad-0.bin")!.size).toBe(6 * 1024 * 1024);
      expect(entries.find((e) => e.path === "prompt.md")!.inline).toBe("published prompt v1");
    });
  });

  // ─── Access control ────────────────────────────────────────────────────────

  describe("access", () => {
    it("reads a system package (orgId null, source system)", async () => {
      const id = "@appstrate/system-agent";
      await seedPackage({
        id,
        orgId: null,
        source: "system",
        type: "agent",
        draftManifest: manifestFor(id),
        draftContent: "system prompt",
      });
      await uploadPackageFiles("agents", SYSTEM_STORAGE_NAMESPACE, id, {
        "extra.txt": encoder.encode("from the _system namespace"),
      });

      const { res, entries } = await listFiles(ctx, id);
      expect(res.status).toBe(200);
      expect(entries.map((e) => e.path)).toEqual(["extra.txt", "manifest.json", "prompt.md"]);
      expect(entries.find((e) => e.path === "extra.txt")!.inline).toBe(
        "from the _system namespace",
      );
    });

    it("404s a package that is not placed in this space", async () => {
      const id = "@fexp/uninstalled";
      // Homed in a stranger's PERSONAL space — the only home an organization
      // owner does not reach (§3.6), and therefore the only way to express
      // "not placed here" now that every organization package has a home
      // (`packages_org_package_has_home`).
      const stranger = await createTestUser();
      const elsewhere = await seedSpace({
        orgId: ctx.orgId,
        name: "Stranger",
        ownerUserId: stranger.id,
        visibility: "private",
      });
      await seedPackage({
        id,
        orgId: ctx.orgId,
        type: "agent",
        draftContent: "hi",
        homeSpaceId: elsewhere.id,
      });

      const { res } = await listFiles(ctx, id);
      expect(res.status).toBe(404);
      expect((await fetchContent(ctx, id, "prompt.md")).status).toBe(404);
    });

    it("404s a package owned by another organization even when installed HERE", async () => {
      const other = await createTestContext({ orgSlug: "fexpother" });
      const id = "@fexpother/private-agent";
      await seedPackage({ id, orgId: other.orgId, type: "agent", draftContent: "secret" });

      // Place and activate it in OUR space on purpose: the fixture builds the
      // strongest state an attacker could reach, so the refusal cannot be
      // coming from a missing row. Seeding it in the FOREIGN space instead
      // would make this test green with every org filter deleted.
      await seedPackageShare(ctx.defaultSpaceId, id);
      await seedSpacePackage(ctx.defaultSpaceId, id);
      // TWO independent boundaries now stand between us and another org's
      // bytes, and this pins both: `isPackageActiveHere` carries the org filter in
      // its own query, and the explorer's read carries `orgOrSystemFilter`.
      expect(await isPackageActiveHere({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, id)).toBe(
        false,
      );
      // The same predicate answers `true` for the org that DOES own it — so
      // the `false` above is the boundary talking, not the fixture failing to
      // activate anything.
      expect(
        await isPackageActiveHere({ orgId: other.orgId, spaceId: ctx.defaultSpaceId }, id),
      ).toBe(true);

      const { res } = await listFiles(ctx, id);
      expect(res.status).toBe(404);
      expect((await fetchContent(ctx, id, "prompt.md")).status).toBe(404);
    });

    it("404s an ephemeral inline-run shadow package", async () => {
      await insertShadowPackage({
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        manifest: manifestFor("@inline/shadow") as unknown as AgentManifest,
        prompt: "shadow prompt",
      });
      const [shadow] = await db.select().from(packages).where(eq(packages.ephemeral, true));
      expect(shadow).toBeDefined();
      await seedPackageShare(ctx.defaultSpaceId, shadow!.id);
      await seedSpacePackage(ctx.defaultSpaceId, shadow!.id);

      const { res } = await listFiles(ctx, shadow!.id);
      expect(res.status).toBe(404);
    });

    it("401s without a session", async () => {
      const res = await app.request("/api/packages/@fexp/draft-agent/files");
      expect(res.status).toBe(401);
    });
  });

  /**
   * WHICH definition a read renders when the caller named none, and who may
   * name the draft (RBAC spec §6.10, R8).
   *
   * These two routes were the fifth door to a working copy, and the widest:
   * the run, the schedule, the readiness endpoint and the bundle export all
   * refuse an explicit `draft` to a caller who cannot WRITE the package, while
   * `?version=draft` here was honoured for anyone holding `<type>:read` — one
   * file at a time, which is the CLI's `packages sync --source draft`. The rule
   * is now the one the detail page answers, from the same two functions:
   * omitted is `writable ? draft : latest ?? draft`, and naming the draft is an
   * author's act.
   *
   * The caller who discriminates is a space `viewer`: `<type>:read` without
   * `<type>:write`. An org owner writes everything and would prove nothing.
   */
  describe("which definition a read renders", () => {
    const id = "@fexp/definition-agent";
    const DRAFT_BODY = "the author's working copy";
    const PUBLISHED_BODY = "the published prompt";

    /** A member of the org holding `preset` in the package's home space. */
    async function memberIn(preset: "viewer" | "builder"): Promise<Record<string, string>> {
      const user = await createTestUser();
      await addOrgMember(ctx.orgId, user.id, "member");
      await seedSpaceMember({ spaceId: homeId, userId: user.id, presetRole: preset });
      return { Cookie: user.cookie, "X-Org-Id": ctx.orgId, "X-Space-Id": homeId };
    }

    async function read(
      headers: Record<string, string>,
      query = "",
    ): Promise<{ status: number; body: string }> {
      const res = await app.request(`/api/packages/${id}/files/content?path=prompt.md${query}`, {
        headers,
      });
      return { status: res.status, body: await res.text() };
    }

    /** A CLOSED space, so every role in it is an explicit membership row. */
    let homeId: string;

    beforeEach(async () => {
      homeId = (await seedSpace({ orgId: ctx.orgId, name: "Home", visibility: "closed" })).id;
      await seedPackage({
        id,
        orgId: ctx.orgId,
        type: "agent",
        homeSpaceId: homeId,
        createdBy: ctx.user.id,
        draftManifest: manifestFor(id),
        draftContent: DRAFT_BODY,
      });
      await seedSpacePackage(homeId, id);
    });

    /** Publish `1.0.0` with a body that differs from the draft — the control. */
    async function publish(): Promise<void> {
      const zip = buildMinimalZip(manifestFor(id), PUBLISHED_BODY, "prompt.md");
      await uploadPackageZip(id, "1.0.0", zip);
      const row = await seedPackageVersion({
        packageId: id,
        version: "1.0.0",
        manifest: manifestFor(id),
        integrity: computeIntegrity(new Uint8Array(zip)),
        artifactSize: zip.byteLength,
      });
      await db
        .insert(packageDistTags)
        .values({ packageId: id, tag: "latest", versionId: row.id })
        .onConflictDoUpdate({
          target: [packageDistTags.packageId, packageDistTags.tag],
          set: { versionId: row.id, updatedAt: new Date() },
        });
    }

    it("serves the PUBLISHED bytes to a reader who cannot write, with no ?version", async () => {
      await publish();
      const { status, body } = await read(await memberIn("viewer"));
      expect(status).toBe(200);
      expect(body).toBe(PUBLISHED_BODY);
    });

    it("serves the DRAFT to the same reader when nothing is published", async () => {
      // Reading is not executing: a readable package whose Files tab 404s is a
      // tab the detail page has just promised. The draft is the only definition
      // that exists here, so it is the one shown — in read-only, and the LAUNCH
      // keeps refusing with `404 no_published_version`.
      const { status, body } = await read(await memberIn("viewer"));
      expect(status).toBe(200);
      expect(body).toBe(DRAFT_BODY);
    });

    it("serves the DRAFT to a writer with no ?version, even once published", async () => {
      await publish();
      const { status, body } = await read(await memberIn("builder"));
      expect(status).toBe(200);
      expect(body).toBe(DRAFT_BODY);
    });

    it("refuses an EXPLICIT ?version=draft to a reader who cannot write", async () => {
      await publish();
      const headers = await memberIn("viewer");
      const { status, body } = await read(headers, "&version=draft");
      expect(status, body).toBe(403);
      expect(JSON.parse(body) as { code?: string }).toMatchObject({
        code: "draft_not_writable",
      });
      expect(body).not.toContain(DRAFT_BODY);

      // The index route answers the same way — it inlines the same bytes, so
      // gating only the content route would leave the cheaper door open.
      const index = await app.request(`/api/packages/${id}/files?version=draft`, { headers });
      expect(index.status).toBe(403);
      expect(await index.text()).not.toContain(DRAFT_BODY);
    });

    it("honours an EXPLICIT ?version=draft for the author", async () => {
      // The discriminating control: what the refusal above is about is the
      // AUTHORITY, not the word `draft`.
      await publish();
      const { status, body } = await read(await memberIn("builder"), "&version=draft");
      expect(status).toBe(200);
      expect(body).toBe(DRAFT_BODY);
    });

    it("still serves an explicit published version to a reader who cannot write", async () => {
      await publish();
      const { status, body } = await read(await memberIn("viewer"), "&version=1.0.0");
      expect(status).toBe(200);
      expect(body).toBe(PUBLISHED_BODY);
    });
  });

  // ─── Content route ─────────────────────────────────────────────────────────

  describe("GET .../files/content", () => {
    const id = "@fexp/content-agent";

    beforeEach(async () => {
      await seedPackage({
        id,
        orgId: ctx.orgId,
        type: "agent",
        draftManifest: manifestFor(id),
        draftContent: "prompt body",
      });
      await seedPackageShare(ctx.defaultSpaceId, id);
      await seedSpacePackage(ctx.defaultSpaceId, id);
    });

    it("serves raw bytes as a non-executable attachment", async () => {
      await uploadPackageFiles("agents", ctx.orgId, id, {
        "page.html": encoder.encode("<script>alert(1)</script>"),
      });

      const res = await fetchContent(ctx, id, "page.html");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Content-Disposition")).toContain("attachment");
      expect(res.headers.get("Content-Disposition")).toContain('filename="page.html"');
      expect(res.headers.get("Content-Length")).toBe("25");
      expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
      expect(await res.text()).toBe("<script>alert(1)</script>");
    });

    it("returns binary bytes intact", async () => {
      const blob = new Uint8Array([0x00, 0xff, 0x10, 0x80, 0xfe]);
      await uploadPackageFiles("agents", ctx.orgId, id, { "blob.bin": blob });

      const res = await fetchContent(ctx, id, "blob.bin");
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(blob);
    });

    it("sanitizes a hostile file name into the Content-Disposition header", async () => {
      // The name carries a quote — which would break out of the quoted-string —
      // and is still a LEGAL package path. It used to carry a backslash and
      // `\r\n` as well; both are refused now, the backslash for a Windows
      // separator and CR/LF because CR/LF in
      // a package path breaks the `.afps` reader and with it every consumer's
      // run, so such a file can no longer be written at all. That refusal is
      // the stronger guarantee, and the case below asserts it — but it is a
      // different property from header escaping, which `attachmentDisposition`
      // owns and `packages/core/test/naming.test.ts` still pins against CR/LF.
      await uploadPackageFiles("agents", ctx.orgId, id, {
        'we"ird name.txt': encoder.encode("x"),
      });

      const res = await fetchContent(ctx, id, 'we"ird name.txt');
      expect(res.status).toBe(200);
      const disposition = res.headers.get("Content-Disposition")!;
      expect(disposition).not.toContain("\r");
      expect(disposition).not.toContain("\n");
      expect(disposition).toBe(
        `attachment; filename="we_ird name.txt"; filename*=UTF-8''we%22ird%20name.txt`,
      );
    });

    it("never serves a name carrying CR or LF, because none can be written", async () => {
      // The positive control for the case above: the hostile name it dropped is
      // not merely untested now, it is unreachable.
      await uploadPackageFiles("agents", ctx.orgId, id, {
        'we"ird\r\nname.txt': encoder.encode("x"),
      });
      expect((await fetchContent(ctx, id, 'we"ird\r\nname.txt')).status).toBe(404);
    });

    it("404s an unknown path", async () => {
      expect((await fetchContent(ctx, id, "nope.md")).status).toBe(404);
      expect((await fetchContent(ctx, id, "../../etc/passwd")).status).toBe(404);
    });

    it("404s prototype keys instead of resolving them off the prototype chain", async () => {
      for (const probe of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
        const res = await fetchContent(ctx, id, probe);
        expect(res.status).toBe(404);
      }
    });

    it("400s a missing path parameter", async () => {
      const res = await app.request(`/api/packages/${id}/files/content`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(400);
    });

    it("retrieves a text file that fell past the index inline budget", async () => {
      // Four ~1 MiB text files: the 2 MiB serialized budget cannot cover them
      // all, but every one of them must remain fetchable in full.
      const chunk = "z".repeat(PACKAGE_FILE_INLINE_MAX_BYTES);
      await uploadPackageFiles("agents", ctx.orgId, id, {
        "a.txt": encoder.encode(chunk),
        "b.txt": encoder.encode(chunk),
        "c.txt": encoder.encode(chunk),
        "d.txt": encoder.encode(chunk),
      });

      const { entries } = await listFiles(ctx, id);
      const dropped = entries.filter((e) => e.path.endsWith(".txt") && e.inline === undefined);
      expect(dropped.length).toBeGreaterThan(0);
      expect(dropped.every((e) => e.media_kind === "text")).toBe(true);

      const res = await fetchContent(ctx, id, dropped[0]!.path);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(chunk);
    });
  });

  // ─── Conditional requests ──────────────────────────────────────────────────

  describe("If-None-Match", () => {
    const id = "@fexp/etag-agent";

    beforeEach(async () => {
      await seedPackage({
        id,
        orgId: ctx.orgId,
        type: "agent",
        draftManifest: manifestFor(id),
        draftContent: "etag body",
      });
      await seedPackageShare(ctx.defaultSpaceId, id);
      await seedSpacePackage(ctx.defaultSpaceId, id);
    });

    it("round-trips to 304 with no body on the index", async () => {
      const { res: first } = await listFiles(ctx, id);
      const etag = first.headers.get("ETag")!;

      const second = await app.request(`/api/packages/${id}/files`, {
        headers: authHeaders(ctx, { "If-None-Match": etag }),
      });
      expect(second.status).toBe(304);
      expect(second.headers.get("ETag")).toBe(etag);
      expect(second.headers.get("Cache-Control")).toBe("private, no-cache");
      expect(await second.text()).toBe("");
    });

    it("round-trips to 304 on the content route", async () => {
      const first = await fetchContent(ctx, id, "prompt.md");
      const etag = first.headers.get("ETag")!;

      const second = await app.request(`/api/packages/${id}/files/content?path=prompt.md`, {
        headers: authHeaders(ctx, { "If-None-Match": etag }),
      });
      expect(second.status).toBe(304);
      expect(await second.text()).toBe("");
    });

    it("serves 200 again once the content changed", async () => {
      const { res: first } = await listFiles(ctx, id);
      const etag = first.headers.get("ETag")!;

      await db.update(packages).set({ draftContent: "etag body v2" }).where(eq(packages.id, id));

      const second = await app.request(`/api/packages/${id}/files`, {
        headers: authHeaders(ctx, { "If-None-Match": etag }),
      });
      expect(second.status).toBe(200);
      expect(second.headers.get("ETag")).not.toBe(etag);
    });

    it("honours a tag list and the wildcard", async () => {
      const { res: first } = await listFiles(ctx, id);
      const etag = first.headers.get("ETag")!;

      const list = await app.request(`/api/packages/${id}/files`, {
        headers: authHeaders(ctx, { "If-None-Match": `"other", ${etag}` }),
      });
      expect(list.status).toBe(304);

      const wildcard = await app.request(`/api/packages/${id}/files`, {
        headers: authHeaders(ctx, { "If-None-Match": "*" }),
      });
      expect(wildcard.status).toBe(304);
    });

    it("gives the index and a file DISTINCT tags", async () => {
      const { res: index } = await listFiles(ctx, id);
      const file = await fetchContent(ctx, id, "prompt.md");
      expect(index.headers.get("ETag")).toMatch(/^"i-pd-[0-9a-f]{64}"$/);
      expect(file.headers.get("ETag")).toMatch(/^"f-pd-[0-9a-f]{64}-[0-9a-f]{32}"$/);
      expect(index.headers.get("ETag")).not.toBe(file.headers.get("ETag"));
    });

    it("gives two files of the same artifact distinct tags", async () => {
      const a = await fetchContent(ctx, id, "prompt.md");
      const b = await fetchContent(ctx, id, "manifest.json");
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.headers.get("ETag")).not.toBe(b.headers.get("ETag"));
    });

    it("does not 304 one file on another file's tag", async () => {
      const other = (await fetchContent(ctx, id, "manifest.json")).headers.get("ETag")!;
      const res = await app.request(`/api/packages/${id}/files/content?path=prompt.md`, {
        headers: authHeaders(ctx, { "If-None-Match": other }),
      });
      expect(res.status).toBe(200);
    });

    it("does not 304 a file on the INDEX's tag", async () => {
      const indexTag = (await listFiles(ctx, id)).res.headers.get("ETag")!;
      const res = await app.request(`/api/packages/${id}/files/content?path=prompt.md`, {
        headers: authHeaders(ctx, { "If-None-Match": indexTag }),
      });
      expect(res.status).toBe(200);
    });

    it("404s — never 304s — a nonexistent path under a wildcard", async () => {
      // `*` carries no path, so it cannot establish that the file exists.
      // Answering 304 here would tell the caller a file is there.
      const res = await app.request(`/api/packages/${id}/files/content?path=nope.md`, {
        headers: authHeaders(ctx, { "If-None-Match": "*" }),
      });
      expect(res.status).toBe(404);
    });

    it("emits Vary on 200 AND 304 of both routes", async () => {
      const expected = "X-Org-Id, X-Space-Id";

      const { res: index } = await listFiles(ctx, id);
      expect(index.headers.get("Vary")).toBe(expected);
      const file = await fetchContent(ctx, id, "prompt.md");
      expect(file.headers.get("Vary")).toBe(expected);

      const indexNotModified = await app.request(`/api/packages/${id}/files`, {
        headers: authHeaders(ctx, { "If-None-Match": index.headers.get("ETag")! }),
      });
      expect(indexNotModified.status).toBe(304);
      expect(indexNotModified.headers.get("Vary")).toBe(expected);

      const fileNotModified = await app.request(
        `/api/packages/${id}/files/content?path=prompt.md`,
        {
          headers: authHeaders(ctx, { "If-None-Match": file.headers.get("ETag")! }),
        },
      );
      expect(fileNotModified.status).toBe(304);
      expect(fileNotModified.headers.get("Vary")).toBe(expected);
    });
  });

  // ─── The exact-version ETag shortcut ───────────────────────────────────────

  describe("conditional request on an exact version", () => {
    const id = "@fexp/no-artifact-agent";
    // Any value works: a version's ETag is derived from the `integrity` COLUMN,
    // which is exactly what makes the shortcut a pure DB read.
    const integrity = "sha256-Wm90aGVCeXRlc05ldmVyRmV0Y2hlZEhlcmVBQUFBQUFBQT0=";

    beforeEach(async () => {
      await seedPackage({
        id,
        orgId: ctx.orgId,
        type: "agent",
        draftManifest: manifestFor(id, "2.0.0"),
        draftContent: "draft prompt",
      });
      await seedPackageShare(ctx.defaultSpaceId, id);
      await seedSpacePackage(ctx.defaultSpaceId, id);
      // A version row WITHOUT its artifact in storage. Any code path that
      // downloads the ZIP to answer the request fails loudly, with
      // `422 version_artifact_unavailable`.
      await seedPackageVersion({
        packageId: id,
        version: "1.0.0",
        manifest: manifestFor(id),
        integrity,
        artifactSize: 999,
      });
    });

    it("422s an unconditional read — proving the artifact really is absent", async () => {
      const { res } = await listFiles(ctx, id, "?version=1.0.0");
      await expectProblem(res, 422, { code: "version_artifact_unavailable" });
    });

    it("304s a conditional index read WITHOUT downloading the artifact", async () => {
      // The artifact is unreachable (previous test). A 304 here is therefore
      // only possible if the validator was resolved from the DB and the bytes
      // were never fetched — a causal proof, no logging seam required.
      const res = await app.request(`/api/packages/${id}/files?version=1.0.0`, {
        headers: authHeaders(ctx, { "If-None-Match": `"i-pv-${integrity}"` }),
      });
      expect(res.status).toBe(304);
      expect(res.headers.get("ETag")).toBe(`"i-pv-${integrity}"`);
      expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
      expect(await res.text()).toBe("");
    });

    it("short-circuits the content route on a genuine PER-FILE tag", async () => {
      const res = await app.request(
        `/api/packages/${id}/files/content?path=prompt.md&version=1.0.0`,
        { headers: authHeaders(ctx, { "If-None-Match": fileTag(integrity, "prompt.md") }) },
      );
      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
    });

    it("does not short-circuit the content route on another file's tag", async () => {
      // No per-file match ⇒ it must go read the artifact, which is absent ⇒
      // 422. That refusal is only reachable from storage, so it is NOT a 304.
      const res = await app.request(
        `/api/packages/${id}/files/content?path=prompt.md&version=1.0.0`,
        { headers: authHeaders(ctx, { "If-None-Match": fileTag(integrity, "other.md") }) },
      );
      await expectProblem(res, 422, { code: "version_artifact_unavailable" });
    });

    it("does not short-circuit the content route on a bare wildcard", async () => {
      // `*` says nothing about WHICH path, so it cannot stand in for "this file
      // exists". It must fall through to the read (which 422s here).
      const res = await app.request(
        `/api/packages/${id}/files/content?path=prompt.md&version=1.0.0`,
        { headers: authHeaders(ctx, { "If-None-Match": "*" }) },
      );
      await expectProblem(res, 422, { code: "version_artifact_unavailable" });
    });

    it("does not short-circuit the content route on the INDEX tag", async () => {
      const res = await app.request(
        `/api/packages/${id}/files/content?path=prompt.md&version=1.0.0`,
        { headers: authHeaders(ctx, { "If-None-Match": `"i-pv-${integrity}"` }) },
      );
      await expectProblem(res, 422, { code: "version_artifact_unavailable" });
    });

    it("still 404s an unknown version before any storage access", async () => {
      const res = await app.request(`/api/packages/${id}/files?version=9.9.9`, {
        headers: authHeaders(ctx, { "If-None-Match": "*" }),
      });
      expect(res.status).toBe(404);
    });

    it("does not short-circuit the draft on a wildcard — the draft validator needs the bytes", async () => {
      // `*` matches any current representation, so the draft index still 304s;
      // but it can only get there by reading, since its id is content-derived.
      const res = await app.request(`/api/packages/${id}/files`, {
        headers: authHeaders(ctx, { "If-None-Match": "*" }),
      });
      expect(res.status).toBe(304);
      expect(res.headers.get("ETag")).toMatch(/^"i-pd-[0-9a-f]{64}"$/);
    });
  });
});

/**
 * The per-file ETag a client would legitimately hold, rebuilt independently of
 * the production helper so the wire format itself is pinned by these tests.
 */
function fileTag(integrity: string, path: string): string {
  const pathDigest = new Bun.CryptoHasher("sha256").update(path).digest("hex").slice(0, 32);
  return `"f-pv-${integrity}-${pathDigest}"`;
}

/** Integrity of the single published version of `id`, for ETag assertions. */
async function versionIntegrity(id: string): Promise<string | undefined> {
  const [row] = await db
    .select({ integrity: packageVersions.integrity })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, id))
    .limit(1);
  return row?.integrity;
}

/**
 * The WRITE half of the same tree — `mutatePackageDraftFiles`.
 *
 * Exercised through the package `PUT`, which is its only route today, and
 * directly for the two guarantees a single HTTP request cannot show: that two
 * writers of one package serialize, and that a caller presenting a validator
 * for a tree that has moved is refused without either store being touched.
 */
describe("draft tree writes", () => {
  const id = "@fexp/write-skill";
  const SKILL_MD = "---\nname: write-skill\ndescription: A written skill.\n---\n\nBody.";
  const NEXT_MD = "---\nname: write-skill\ndescription: A written skill.\n---\n\nRewritten.";
  const decoder = new TextDecoder();
  let ctx: TestContext;

  function skillManifest(version = "1.0.0"): Record<string, unknown> {
    return {
      name: id,
      version,
      type: "skill",
      schema_version: "0.1",
      display_name: "Write Skill",
      description: "A written skill.",
    };
  }

  /** The package's stored ZIP, as the next reader would unzip it. */
  async function storedTree(): Promise<Record<string, Uint8Array>> {
    const files = await downloadPackageFiles("skills", ctx.orgId, id);
    expect(files).not.toBeNull();
    return files!;
  }

  async function lockVersionOf(): Promise<number> {
    const [row] = await db
      .select({ lockVersion: packages.lockVersion })
      .from(packages)
      .where(eq(packages.id, id))
      .limit(1);
    return row!.lockVersion;
  }

  async function saveContent(content: string, lockVersion: number): Promise<Response> {
    return app.request(`/api/packages/skills/${id}`, {
      method: "PUT",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ content, lock_version: lockVersion }),
    });
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "fexp" });
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "skill",
      draftManifest: skillManifest(),
      draftContent: SKILL_MD,
    });
    await seedPackageShare(ctx.defaultSpaceId, id);
    await seedSpacePackage(ctx.defaultSpaceId, id);
    await uploadPackageFiles("skills", ctx.orgId, id, {
      "SKILL.md": encoder.encode(SKILL_MD),
      "scripts/run.py": encoder.encode("print(1)"),
      "assets/logo.bin": new Uint8Array([0, 1, 2, 3]),
    });
  });

  it("a content-only PUT rewrites the content entry and keeps every other file", async () => {
    const res = await saveContent(NEXT_MD, await lockVersionOf());
    expect(res.status).toBe(200);

    const stored = await storedTree();
    expect(Object.keys(stored).sort()).toEqual(["SKILL.md", "assets/logo.bin", "scripts/run.py"]);
    expect(decoder.decode(stored["SKILL.md"]!)).toBe(NEXT_MD);
    expect(decoder.decode(stored["scripts/run.py"]!)).toBe("print(1)");
    expect(Array.from(stored["assets/logo.bin"]!)).toEqual([0, 1, 2, 3]);

    const { entries } = await listFiles(ctx, id);
    expect(entries.map((e) => e.path)).toEqual([
      "SKILL.md",
      "assets/logo.bin",
      "manifest.json",
      "scripts/run.py",
    ]);
  });

  it("a stale lock_version is still a 409, and neither store moves", async () => {
    const stale = (await lockVersionOf()) + 7;
    const res = await saveContent(NEXT_MD, stale);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe("conflict");
    expect(body.detail).toBe("Skill was modified concurrently. Reload and try again.");

    // Negative control: the refusal happens before either write.
    expect(decoder.decode((await storedTree())["SKILL.md"]!)).toBe(SKILL_MD);
    const [row] = await db
      .select({ draftContent: packages.draftContent })
      .from(packages)
      .where(eq(packages.id, id))
      .limit(1);
    expect(row!.draftContent).toBe(SKILL_MD);
  });

  it("serializes two concurrent writers — pg_advisory_xact_lock holds on this tier", async () => {
    // What this asserts depends on the tier, and both halves are worth having.
    // On tier 0 (PGlite, ONE connection) the two calls cannot overlap at all,
    // so it proves only that `pg_advisory_xact_lock(hashtext(...))` parses and
    // runs on this tier — the thing the plan required verifying before building
    // on it. On CI's real PostgreSQL the two transactions do overlap, and the
    // assertion bites: without the lock the second writer reads the tree the
    // first has not stored yet and drops its file.
    const target = { id, type: "skill" as const, orgId: ctx.orgId };
    const add = (path: string, text: string) => ({
      precondition: { imported: true as const },
      mutate: (files: Record<string, Uint8Array>) => ({
        ...files,
        [path]: encoder.encode(text),
      }),
    });

    const [first, second] = await Promise.all([
      mutatePackageDraftFiles(target, add("docs/a.md", "A")),
      mutatePackageDraftFiles(target, add("docs/b.md", "B")),
    ]);

    const stored = await storedTree();
    expect(Object.keys(stored).sort()).toEqual([
      "SKILL.md",
      "assets/logo.bin",
      "docs/a.md",
      "docs/b.md",
      "scripts/run.py",
    ]);
    // Each write bumps the row exactly once, so the two tokens differ by one.
    expect(Math.abs(first.lockVersion - second.lockVersion)).toBe(1);
  });

  it("accepts the draft token and refuses a stale one", async () => {
    const { res } = await listFiles(ctx, id);
    const etag = res.headers.get("ETag")!;
    const lockVersion = await lockVersionOf();
    expect(etag).toMatch(/^"i-pd-[0-9a-f]{64}"$/);

    const written = await mutatePackageDraftFiles(
      { id, type: "skill", orgId: ctx.orgId },
      {
        precondition: { lockVersion },
        mutate: (files) => ({ ...files, "docs/note.md": encoder.encode("noted") }),
      },
    );
    expect(Object.keys(written.snapshot.files).sort()).toEqual([
      "SKILL.md",
      "assets/logo.bin",
      "docs/note.md",
      "manifest.json",
      "scripts/run.py",
    ]);
    // The returned snapshot is what the next GET reports, ETag included.
    const after = await listFiles(ctx, id);
    expect(after.res.headers.get("ETag")).toBe(indexEtag(written.snapshot.snapshotId));

    // The same validator a second time now names a tree that has moved.
    let refused: unknown;
    await mutatePackageDraftFiles(
      { id, type: "skill", orgId: ctx.orgId },
      {
        precondition: { lockVersion },
        mutate: (files) => ({ ...files, "docs/late.md": encoder.encode("late") }),
      },
    ).catch((err: unknown) => {
      refused = err;
    });
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(409);
    expect((refused as ApiError).code).toBe("conflict");

    // Negative control: nothing of the refused write reached storage.
    expect(Object.keys(await storedTree())).not.toContain("docs/late.md");
  });
});
