// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only package file explorer:
 *   GET /api/packages/{scope}/{name}/files
 *   GET /api/packages/{scope}/{name}/files/content
 *
 * The invariants worth locking down are the ones a naive implementation gets
 * wrong: the draft is the DB overlaid on the stored ZIP (not the ZIP), a
 * published version is the pinned bytes (not the draft), the access gate is
 * the application install, and the bytes route can never be tricked into
 * serving something a browser will execute.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { packages, packageDistTags, packageVersions } from "@appstrate/db/schema";
import { computeIntegrity } from "@appstrate/core/integrity";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage, seedPackageVersion } from "../../helpers/seed.ts";
import {
  uploadPackageFiles,
  SYSTEM_STORAGE_NAMESPACE,
} from "../../../src/services/package-items/storage.ts";
import { uploadPackageZip, buildMinimalZip } from "../../../src/services/package-storage.ts";
import { insertShadowPackage } from "../../../src/services/inline-run.ts";
import { hasPackageAccess } from "../../../src/services/application-packages.ts";
import type { AgentManifest } from "../../../src/types/index.ts";
import { INLINE_MAX_BYTES } from "../../../src/services/package-files.ts";

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
      await seedInstalledPackage(ctx.defaultAppId, id);
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
        orgId: ctx.orgId,
        type: "skill",
        draftManifest: { ...manifestFor(skillId), type: "skill" },
        draftContent: "---\nname: a-skill\n---\nbody",
      });
      await seedInstalledPackage(ctx.defaultAppId, skillId);

      const { entries } = await listFiles(ctx, skillId);
      expect(entries.map((e) => e.path)).toEqual(["SKILL.md", "manifest.json"]);
      expect(entries.find((e) => e.path === "SKILL.md")!.inline).toBe(
        "---\nname: a-skill\n---\nbody",
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
        orgId: ctx.orgId,
        type: "integration",
        draftManifest: { ...manifestFor(intId), type: "integration" },
        draftContent: "# Updated integration docs",
      });
      await seedInstalledPackage(ctx.defaultAppId, intId);
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
        orgId: ctx.orgId,
        type: "integration",
        draftManifest: manifest,
        draftContent: JSON.stringify(manifest),
      });
      await seedInstalledPackage(ctx.defaultAppId, intId);
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
        orgId: ctx.orgId,
        type: "mcp-server",
        draftManifest: manifest,
        draftContent: JSON.stringify(manifest),
      });
      await seedInstalledPackage(ctx.defaultAppId, mcpId);
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
        orgId: ctx.orgId,
        type: "mcp-server",
        draftManifest: manifest,
        draftContent: "",
      });
      await seedInstalledPackage(ctx.defaultAppId, mcpId);

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
      await seedInstalledPackage(ctx.defaultAppId, id);

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

    it("caches an EXACT version pin immutably", async () => {
      const { res } = await listFiles(ctx, id, "?version=1.0.0");
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
      expect(res.headers.get("ETag")).toBe(`"i-pv-${(await versionIntegrity(id))!}"`);
    });

    it("resolves a dist-tag but must NOT mark it immutable", async () => {
      // `?version=latest` is a MOVING target: pinning it for a year would mean
      // publishing 1.1.0 never reaches a client that already cached 1.0.0.
      const { res, entries } = await listFiles(ctx, id, "?version=latest");
      expect(res.status).toBe(200);
      expect(entries.find((e) => e.path === "prompt.md")!.inline).toBe("published prompt v1");
      expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
      // Same content tag as the exact pin — only the freshness policy differs.
      expect(res.headers.get("ETag")).toBe(`"i-pv-${(await versionIntegrity(id))!}"`);
    });

    it("resolves a semver range without marking it immutable", async () => {
      const { res } = await listFiles(ctx, id, "?version=%5E1.0.0");
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    });

    it("never marks a yanked version immutable, and flags it with X-Yanked", async () => {
      await db
        .update(packageVersions)
        .set({ yanked: true, yankedReason: "bad release" })
        .where(eq(packageVersions.packageId, id));

      const { res } = await listFiles(ctx, id, "?version=1.0.0");
      expect(res.status).toBe(200);
      // An immutable copy could never learn it had been withdrawn.
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

    it("404s a package that is not installed in this application", async () => {
      const id = "@fexp/uninstalled";
      await seedPackage({ id, orgId: ctx.orgId, type: "agent", draftContent: "hi" });

      const { res } = await listFiles(ctx, id);
      expect(res.status).toBe(404);
      expect((await fetchContent(ctx, id, "prompt.md")).status).toBe(404);
    });

    it("404s a package owned by another organization even when installed HERE", async () => {
      const other = await createTestContext({ orgSlug: "fexpother" });
      const id = "@fexpother/private-agent";
      await seedPackage({ id, orgId: other.orgId, type: "agent", draftContent: "secret" });

      // Install it in OUR application on purpose. `hasPackageAccess` does not
      // filter `orgId`, so it now PASSES — which leaves `orgOrSystemFilter` as
      // the only thing standing between us and another org's bytes. Seeding
      // the install in the foreign app instead would make this test green with
      // the org filter deleted.
      await seedInstalledPackage(ctx.defaultAppId, id);
      expect(
        await hasPackageAccess({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, id),
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
      await seedInstalledPackage(ctx.defaultAppId, shadow!.id);

      const { res } = await listFiles(ctx, shadow!.id);
      expect(res.status).toBe(404);
    });

    it("401s without a session", async () => {
      const res = await app.request("/api/packages/@fexp/draft-agent/files");
      expect(res.status).toBe(401);
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
      await seedInstalledPackage(ctx.defaultAppId, id);
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
      await uploadPackageFiles("agents", ctx.orgId, id, {
        'we"ird\r\nname.txt': encoder.encode("x"),
      });

      const res = await fetchContent(ctx, id, 'we"ird\r\nname.txt');
      expect(res.status).toBe(200);
      const disposition = res.headers.get("Content-Disposition")!;
      expect(disposition).not.toContain("\r");
      expect(disposition).not.toContain("\n");
      expect(disposition).toBe(
        `attachment; filename="we_ird__name.txt"; filename*=UTF-8''we%22ird%0D%0Aname.txt`,
      );
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
      const chunk = "z".repeat(INLINE_MAX_BYTES);
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
      await seedInstalledPackage(ctx.defaultAppId, id);
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
      const expected = "X-Org-Id, X-Application-Id";

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

  // ─── The immutable-ETag shortcut ───────────────────────────────────────────

  describe("conditional request on an immutable version", () => {
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
      await seedInstalledPackage(ctx.defaultAppId, id);
      // A version row WITHOUT its artifact in storage. Any code path that
      // downloads the ZIP to answer the request must fail loudly.
      await seedPackageVersion({
        packageId: id,
        version: "1.0.0",
        manifest: manifestFor(id),
        integrity,
        artifactSize: 999,
      });
    });

    it("404s an unconditional read — proving the artifact really is absent", async () => {
      const { res } = await listFiles(ctx, id, "?version=1.0.0");
      expect(res.status).toBe(404);
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
      expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
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
      // No per-file match ⇒ it must go read the artifact, which is absent ⇒ 404.
      // The important part is that it is NOT a 304.
      const res = await app.request(
        `/api/packages/${id}/files/content?path=prompt.md&version=1.0.0`,
        { headers: authHeaders(ctx, { "If-None-Match": fileTag(integrity, "other.md") }) },
      );
      expect(res.status).toBe(404);
    });

    it("does not short-circuit the content route on a bare wildcard", async () => {
      // `*` says nothing about WHICH path, so it cannot stand in for "this file
      // exists". It must fall through to the read (which 404s here).
      const res = await app.request(
        `/api/packages/${id}/files/content?path=prompt.md&version=1.0.0`,
        { headers: authHeaders(ctx, { "If-None-Match": "*" }) },
      );
      expect(res.status).toBe(404);
    });

    it("does not short-circuit the content route on the INDEX tag", async () => {
      const res = await app.request(
        `/api/packages/${id}/files/content?path=prompt.md&version=1.0.0`,
        { headers: authHeaders(ctx, { "If-None-Match": `"i-pv-${integrity}"` }) },
      );
      expect(res.status).toBe(404);
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
