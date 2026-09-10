// SPDX-License-Identifier: Apache-2.0

/**
 * The draft-tree write route:
 *   PATCH /api/packages/{scope}/{name}/files
 *
 * The guarantees worth pinning are the ones a naive implementation loses. A
 * batch is ATOMIC — every refusal below asserts that neither the stored ZIP nor
 * `packages.draft_content` moved, because a partially applied rename is the one
 * outcome an author cannot undo. The tree this route writes is the SAME tree the
 * explorer reads, the publish freezes and a draft run mounts, so the write is
 * followed through all three. And the concurrency story is two guards over one
 * row: the `PUT` bumps `lock_version`, this route matches the index `ETag`, and
 * a stale tab must get a number rather than a silent overwrite.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditEvents, packages } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedInstalledPackage, seedApiKey } from "../../helpers/seed.ts";
import {
  uploadPackageFiles,
  downloadPackageFiles,
  SYSTEM_STORAGE_NAMESPACE,
} from "../../../src/services/package-items/storage.ts";
import { unzipPackageArchive } from "../../../src/services/package-archive.ts";
import { DraftPackageCatalog } from "../../../src/services/run-launcher/draft-package-catalog.ts";
import { PACKAGE_FILE_INLINE_MAX_BYTES } from "@appstrate/core/package-files";

const app = getTestApp();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const SKILL_ID = "@fw/edit-skill";
const SKILL_MD = "---\nname: edit-skill\ndescription: An edited skill.\n---\n\nBody.";
const LOGO_BYTES = new Uint8Array([0, 1, 2, 253, 254, 255]);

interface FileEntry {
  path: string;
  size: number;
  media_kind: "text" | "binary";
  inline?: string;
}

type WriteOperation =
  | { op: "write"; path: string; text?: string; bytes_base64?: string }
  | { op: "delete"; path: string }
  | { op: "move"; from: string; to: string };

function skillManifest(version = "1.0.0"): Record<string, unknown> {
  return {
    name: SKILL_ID,
    version,
    type: "skill",
    schema_version: "0.1",
    display_name: "Edit Skill",
    description: "An edited skill.",
  };
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

describe("PATCH /api/packages/{scope}/{name}/files", () => {
  let ctx: TestContext;

  /** The package's stored ZIP, as the next reader would unzip it. */
  async function storedTree(id = SKILL_ID): Promise<Record<string, Uint8Array>> {
    const files = await downloadPackageFiles("skills", ctx.orgId, id);
    expect(files).not.toBeNull();
    return files!;
  }

  async function packageRow(id = SKILL_ID) {
    const [row] = await db
      .select({ draftContent: packages.draftContent, lockVersion: packages.lockVersion })
      .from(packages)
      .where(eq(packages.id, id))
      .limit(1);
    return row!;
  }

  async function listFiles(
    id = SKILL_ID,
  ): Promise<{ res: Response; entries: FileEntry[]; etag: string }> {
    const res = await app.request(`/api/packages/${id}/files`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.clone().json()) as { entries: FileEntry[] };
    return { res, entries: body.entries, etag: res.headers.get("ETag")! };
  }

  async function fileBytes(path: string, id = SKILL_ID): Promise<Uint8Array> {
    const res = await app.request(
      `/api/packages/${id}/files/content?path=${encodeURIComponent(path)}`,
      { headers: authHeaders(ctx) },
    );
    expect(res.status).toBe(200);
    return new Uint8Array(await res.arrayBuffer());
  }

  async function patchFiles(
    operations: WriteOperation[],
    opts: { etag?: string | null; id?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const id = opts.id ?? SKILL_ID;
    const etag = opts.etag === undefined ? (await listFiles(id)).etag : opts.etag;
    const headers: Record<string, string> = {
      ...(opts.headers ?? authHeaders(ctx)),
      "Content-Type": "application/json",
    };
    if (etag !== null) headers["If-Match"] = etag;
    return app.request(`/api/packages/${id}/files`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ operations }),
    });
  }

  async function problem(res: Response): Promise<{ code?: string; detail?: string }> {
    return (await res.json()) as { code?: string; detail?: string };
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "fw" });
    await seedPackage({
      id: SKILL_ID,
      orgId: ctx.orgId,
      type: "skill",
      createdBy: ctx.user.id,
      draftManifest: skillManifest(),
      draftContent: SKILL_MD,
    });
    await seedInstalledPackage(ctx.defaultSpaceId, SKILL_ID);
    await uploadPackageFiles("skills", ctx.orgId, SKILL_ID, {
      "SKILL.md": encoder.encode(SKILL_MD),
      "scripts/run.py": encoder.encode("print(1)"),
      "assets/logo.bin": LOGO_BYTES,
    });
  });

  // ─── Happy path ────────────────────────────────────────────────────────────

  describe("applying a batch", () => {
    it("writes a text file, and the index lists it with its content", async () => {
      const res = await patchFiles([{ op: "write", path: "docs/notes.md", text: "# Notes" }]);
      expect(res.status).toBe(200);

      const { entries } = await listFiles();
      expect(entries.find((e) => e.path === "docs/notes.md")!.inline).toBe("# Notes");
      expect(decoder.decode((await storedTree())["docs/notes.md"]!)).toBe("# Notes");
    });

    it("round-trips bytes_base64 byte-exact through the content route", async () => {
      const bytes = new Uint8Array([0, 127, 128, 255, 10, 13, 0]);
      const res = await patchFiles([
        { op: "write", path: "assets/blob.bin", bytes_base64: base64(bytes) },
      ]);
      expect(res.status).toBe(200);

      expect(Array.from(await fileBytes("assets/blob.bin"))).toEqual(Array.from(bytes));
      const { entries } = await listFiles();
      expect(entries.find((e) => e.path === "assets/blob.bin")!.media_kind).toBe("binary");
    });

    it("deletes a file", async () => {
      const res = await patchFiles([{ op: "delete", path: "scripts/run.py" }]);
      expect(res.status).toBe(200);

      expect(Object.keys(await storedTree())).not.toContain("scripts/run.py");
      const { entries } = await listFiles();
      expect(entries.map((e) => e.path)).not.toContain("scripts/run.py");
    });

    it("moves a file, carrying its bytes to the new path", async () => {
      const res = await patchFiles([{ op: "move", from: "scripts/run.py", to: "scripts/main.py" }]);
      expect(res.status).toBe(200);

      const stored = await storedTree();
      expect(Object.keys(stored)).not.toContain("scripts/run.py");
      expect(decoder.decode(stored["scripts/main.py"]!)).toBe("print(1)");
    });

    it("applies write, binary write, delete and move as one batch, and answers with the new tree", async () => {
      const before = await listFiles();
      const res = await patchFiles(
        [
          { op: "write", path: "docs/notes.md", text: "# Notes" },
          { op: "write", path: "assets/icon.bin", bytes_base64: base64(new Uint8Array([9, 8])) },
          { op: "delete", path: "assets/logo.bin" },
          { op: "move", from: "scripts/run.py", to: "scripts/main.py" },
        ],
        { etag: before.etag },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entries: FileEntry[]; lock_version: number };

      const after = await listFiles();
      expect(after.entries.map((e) => e.path)).toEqual([
        "SKILL.md",
        "assets/icon.bin",
        "docs/notes.md",
        "manifest.json",
        "scripts/main.py",
      ]);
      // The response IS the next GET, so a client replaces its cache with it
      // rather than re-reading a tree it just wrote.
      expect(body.entries).toEqual(after.entries);
      expect(res.headers.get("ETag")).toBe(after.etag);
      expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
      expect(res.headers.get("Vary")).toBe("X-Org-Id, X-Space-Id");
      expect(body.lock_version).toBe((await packageRow()).lockVersion);
    });
  });

  // ─── The tree this route writes is the tree everything else reads ──────────

  describe("what the write reaches", () => {
    it("rewrites draft_content when the batch writes SKILL.md, so the detail route serves it", async () => {
      const next = "---\nname: edit-skill\ndescription: An edited skill.\n---\n\nRewritten.";
      expect((await patchFiles([{ op: "write", path: "SKILL.md", text: next }])).status).toBe(200);

      expect((await packageRow()).draftContent).toBe(next);
      const detail = await app.request(`/api/packages/skills/${SKILL_ID}`, {
        headers: authHeaders(ctx),
      });
      expect(detail.status).toBe(200);
      expect(((await detail.json()) as { content: string }).content).toBe(next);
    });

    it("freezes a file added by the batch into the next published version", async () => {
      expect(
        (await patchFiles([{ op: "write", path: "references/data.md", text: "reference" }])).status,
      ).toBe(200);

      const published = await app.request(`/api/packages/skills/${SKILL_ID}/versions`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ version: "1.0.0" }),
      });
      expect(published.status).toBe(201);

      const download = await app.request(`/api/packages/${SKILL_ID}/1.0.0/download`, {
        headers: authHeaders(ctx),
      });
      expect(download.status).toBe(200);
      const frozen = unzipPackageArchive(new Uint8Array(await download.arrayBuffer()));
      expect(decoder.decode(frozen["references/data.md"]!)).toBe("reference");
    });

    it("records the paths the batch touched in the audit trail", async () => {
      expect(
        (
          await patchFiles([
            { op: "write", path: "docs/notes.md", text: "# Notes" },
            { op: "move", from: "scripts/run.py", to: "scripts/main.py" },
            { op: "delete", path: "assets/logo.bin" },
          ])
        ).status,
      ).toBe(200);

      const [audit] = await db
        .select({ after: auditEvents.after })
        .from(auditEvents)
        .where(
          and(eq(auditEvents.action, "package.updated"), eq(auditEvents.resourceId, SKILL_ID)),
        );
      // WHICH entries moved, not just how many: after the write the tree they
      // were in no longer exists anywhere to answer that.
      expect(audit!.after).toMatchObject({
        type: "skill",
        fileOperations: 3,
        filePaths: ["docs/notes.md", "scripts/run.py \u2192 scripts/main.py", "assets/logo.bin"],
      });
      // The bytes are the package itself and stay out of the trail.
      expect(JSON.stringify(audit!.after)).not.toContain("# Notes");
    });

    it("hands a file added by the batch to a draft run's bundle catalog", async () => {
      expect(
        (await patchFiles([{ op: "write", path: "scripts/helper.py", text: "print(2)" }])).status,
      ).toBe(200);

      // The catalog a draft run resolves its skills through — the same code path
      // `buildAgentPackage` takes, with no run to launch.
      const catalog = new DraftPackageCatalog({ orgId: ctx.orgId });
      const resolved = await catalog.resolve(SKILL_ID, "*");
      expect(resolved).not.toBeNull();
      const pkg = await catalog.fetch(resolved!.identity);
      expect(decoder.decode(pkg.files.get("scripts/helper.py")!)).toBe("print(2)");
    });
  });

  // ─── Refusals ──────────────────────────────────────────────────────────────

  describe("refusals", () => {
    /** Neither store moved: the fixture's tree and draft column, unchanged. */
    async function expectNothingWritten(): Promise<void> {
      const stored = await storedTree();
      expect(Object.keys(stored).sort()).toEqual(["SKILL.md", "assets/logo.bin", "scripts/run.py"]);
      expect(decoder.decode(stored["SKILL.md"]!)).toBe(SKILL_MD);
      expect((await packageRow()).draftContent).toBe(SKILL_MD);
    }

    it("refuses every path shape the archive cannot carry", async () => {
      for (const path of [
        "../escape.md",
        "dir\\file.md",
        "__MACOSX/x.md",
        "dir//x.md",
        "./notes.md",
        "docs/./notes.md",
        "C:/notes.md",
      ]) {
        const res = await patchFiles([{ op: "write", path, text: "x" }]);
        expect(`${path}: ${res.status}`).toBe(`${path}: 400`);
        expect(`${path}: ${(await problem(res)).code}`).toBe(`${path}: invalid_path`);
        await expectNothingWritten();
      }
    });

    it("refuses to write manifest.json, which the package PUT owns", async () => {
      const res = await patchFiles([{ op: "write", path: "manifest.json", text: "{}" }]);
      expect(res.status).toBe(400);
      expect((await problem(res)).code).toBe("reserved_entry");
      await expectNothingWritten();
    });

    it("refuses to delete the content entry a skill is defined by", async () => {
      const res = await patchFiles([{ op: "delete", path: "SKILL.md" }]);
      expect(res.status).toBe(400);
      expect((await problem(res)).code).toBe("content_entry_immovable");
      await expectNothingWritten();
    });

    it("refuses to move the content entry away", async () => {
      const res = await patchFiles([{ op: "move", from: "SKILL.md", to: "docs/SKILL.md" }]);
      expect(res.status).toBe(400);
      expect((await problem(res)).code).toBe("content_entry_immovable");
      await expectNothingWritten();
    });

    it("refuses a move onto a path that is already taken", async () => {
      const res = await patchFiles([{ op: "move", from: "scripts/run.py", to: "assets/logo.bin" }]);
      expect(res.status).toBe(400);
      expect((await problem(res)).code).toBe("path_conflict");
      await expectNothingWritten();
    });

    it("refuses a name only a case-insensitive filesystem would merge with another", async () => {
      // `skill.md` beside `SKILL.md` is two entries in a ZIP and ONE file once
      // `skills sync` writes it to APFS — where `skill.md` lands last by sort
      // order, so the runtime would load a body this route never gated.
      const res = await patchFiles([{ op: "write", path: "skill.md", text: "not the real one" }]);
      expect(res.status).toBe(400);
      expect((await problem(res)).code).toBe("path_conflict");
      await expectNothingWritten();
    });

    it("refuses a SKILL.md whose frontmatter does not parse", async () => {
      const res = await patchFiles([
        { op: "write", path: "SKILL.md", text: "no frontmatter here" },
      ]);
      expect(res.status).toBe(400);
      await expectNothingWritten();
    });

    it("refuses a file past the 1 MiB per-file ceiling with 413", async () => {
      const oversized = new Uint8Array(PACKAGE_FILE_INLINE_MAX_BYTES + 1);
      const res = await patchFiles([
        { op: "write", path: "assets/big.bin", bytes_base64: base64(oversized) },
      ]);
      expect(res.status).toBe(413);
      expect((await problem(res)).code).toBe("file_too_large");
      await expectNothingWritten();
    });

    it("refuses more than 200 operations in one request", async () => {
      const operations: WriteOperation[] = Array.from({ length: 201 }, (_, i) => ({
        op: "write",
        path: `docs/n${i}.md`,
        text: "x",
      }));
      const res = await patchFiles(operations);
      expect(res.status).toBe(400);
      await expectNothingWritten();
    });

    it("refuses a write carrying both text and bytes_base64, and one carrying neither", async () => {
      const both = await patchFiles([
        { op: "write", path: "docs/a.md", text: "x", bytes_base64: base64(encoder.encode("y")) },
      ]);
      expect(both.status).toBe(400);
      const neither = await patchFiles([{ op: "write", path: "docs/a.md" }]);
      expect(neither.status).toBe(400);
      await expectNothingWritten();
    });

    it("refuses a bytes_base64 payload that is not standard base64", async () => {
      // Outside the alphabet, truncated (a `% 4 === 1` remainder no valid
      // base64 string can have), and URL-safe — which is a second spelling of
      // the same bytes, not a second encoding this route accepts.
      for (const payload of ["not base64!", "aGVsbG8hZ", "_-_-"]) {
        const res = await patchFiles([
          { op: "write", path: "assets/x.bin", bytes_base64: payload },
        ]);
        expect(`${payload}: ${res.status}`).toBe(`${payload}: 400`);
      }
      await expectNothingWritten();
    });

    it("refuses a package type whose files are authored by importing an archive", async () => {
      const mcpId = "@fw/a-server";
      await seedPackage({
        id: mcpId,
        orgId: ctx.orgId,
        type: "mcp-server",
        createdBy: ctx.user.id,
        draftManifest: { name: mcpId, version: "1.0.0", type: "mcp-server", schema_version: "0.1" },
      });
      await seedInstalledPackage(ctx.defaultSpaceId, mcpId);

      const res = await patchFiles([{ op: "write", path: "docs/a.md", text: "x" }], { id: mcpId });
      expect(res.status).toBe(400);
      expect((await problem(res)).code).toBe("package_type_not_editable");
    });

    it("404s a delete of a path the tree does not hold", async () => {
      const res = await patchFiles([{ op: "delete", path: "scripts/absent.py" }]);
      expect(res.status).toBe(404);
      expect((await problem(res)).code).toBe("not_found");
      await expectNothingWritten();
    });
  });

  // ─── Preconditions ─────────────────────────────────────────────────────────

  describe("preconditions", () => {
    async function putSkill(content: string, lockVersion: number): Promise<Response> {
      return app.request(`/api/packages/skills/${SKILL_ID}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ content, lock_version: lockVersion }),
      });
    }

    it("428s a write that carries no If-Match at all", async () => {
      const res = await patchFiles([{ op: "write", path: "docs/a.md", text: "x" }], { etag: null });
      expect(res.status).toBe(428);
      expect((await problem(res)).code).toBe("precondition_required");
      expect(Object.keys(await storedTree())).not.toContain("docs/a.md");
    });

    it("412s a write whose If-Match no longer names this tree", async () => {
      const stale = (await listFiles()).etag;
      expect((await patchFiles([{ op: "write", path: "docs/a.md", text: "x" }])).status).toBe(200);

      const res = await patchFiles([{ op: "write", path: "docs/b.md", text: "y" }], {
        etag: stale,
      });
      expect(res.status).toBe(412);
      expect((await problem(res)).code).toBe("precondition_failed");
      expect(Object.keys(await storedTree())).not.toContain("docs/b.md");
    });

    it("accepts `*` as a deliberate overwrite of whatever is there", async () => {
      const res = await patchFiles([{ op: "write", path: "docs/a.md", text: "x" }], { etag: "*" });
      expect(res.status).toBe(200);
      expect(decoder.decode((await storedTree())["docs/a.md"]!)).toBe("x");
    });

    it("moves the row's lock_version, so a PUT holding the pre-batch token is refused", async () => {
      const before = (await packageRow()).lockVersion;
      const patched = await patchFiles([{ op: "write", path: "docs/a.md", text: "x" }]);
      expect(patched.status).toBe(200);
      const { lock_version } = (await patched.json()) as { lock_version: number };

      const next = "---\nname: edit-skill\ndescription: An edited skill.\n---\n\nVia PUT.";
      const stale = await putSkill(next, before);
      expect(stale.status).toBe(409);

      const fresh = await putSkill(next, lock_version);
      expect(fresh.status).toBe(200);
    });

    it("412s a batch holding the ETag from before a package PUT", async () => {
      const stale = (await listFiles()).etag;
      const next = "---\nname: edit-skill\ndescription: An edited skill.\n---\n\nVia PUT.";
      expect((await putSkill(next, (await packageRow()).lockVersion)).status).toBe(200);

      const res = await patchFiles([{ op: "write", path: "docs/a.md", text: "x" }], {
        etag: stale,
      });
      expect(res.status).toBe(412);
      expect(Object.keys(await storedTree())).not.toContain("docs/a.md");
    });
  });

  // ─── The other writers of the same tree ────────────────────────────────────

  describe("a version restore", () => {
    async function publish(version: string): Promise<Response> {
      return app.request(`/api/packages/skills/${SKILL_ID}/versions`, {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ version }),
      });
    }

    async function restore(version: string): Promise<Response> {
      return app.request(`/api/packages/skills/${SKILL_ID}/versions/${version}/restore`, {
        method: "POST",
        headers: authHeaders(ctx),
      });
    }

    it("replaces row and stored tree together, and moves the row's token", async () => {
      expect(
        (await patchFiles([{ op: "write", path: "references/data.md", text: "reference" }])).status,
      ).toBe(200);
      expect((await publish("1.0.0")).status).toBe(201);

      // Draft moves on after the version: one more file, and a rewritten body.
      const rewritten = "---\nname: edit-skill\ndescription: An edited skill.\n---\n\nAfter.";
      const patched = await patchFiles([
        { op: "write", path: "scratch/tmp.md", text: "scratch" },
        { op: "write", path: "SKILL.md", text: rewritten },
      ]);
      expect(patched.status).toBe(200);
      const afterPatch = (await patched.json()) as { lock_version: number };

      expect((await restore("1.0.0")).status).toBe(200);

      // The version's entries ARE the draft tree now — the later file is gone,
      // and `manifest.json` is not stored for a skill (the row owns it, the
      // read overlay materializes it).
      const stored = await storedTree();
      expect(Object.keys(stored).sort()).toEqual([
        "SKILL.md",
        "assets/logo.bin",
        "references/data.md",
        "scripts/run.py",
      ]);
      expect(decoder.decode(stored["SKILL.md"]!)).toBe(SKILL_MD);

      // Both stores moved, in step: the row's content entry matches the bytes,
      // and the index the explorer serves is built from the same pair.
      const row = await packageRow();
      expect(row.draftContent).toBe(SKILL_MD);
      expect(row.lockVersion).toBeGreaterThan(afterPatch.lock_version);
      const { entries } = await listFiles();
      expect(entries.map((e) => e.path)).toEqual([
        "SKILL.md",
        "assets/logo.bin",
        "manifest.json",
        "references/data.md",
        "scripts/run.py",
      ]);
      expect(entries.find((e) => e.path === "SKILL.md")!.inline).toBe(SKILL_MD);
    });

    it("refuses a batch composed against the pre-restore tree, rather than losing it", async () => {
      expect((await publish("1.0.0")).status).toBe(201);
      // The draft has to move past the version, or restoring it is a no-op and
      // the validator below would still be live — proving nothing.
      expect((await patchFiles([{ op: "write", path: "scratch/tmp.md", text: "t" }])).status).toBe(
        200,
      );
      const stale = (await listFiles()).etag;
      expect((await restore("1.0.0")).status).toBe(200);
      expect(Object.keys(await storedTree())).not.toContain("scratch/tmp.md");

      const res = await patchFiles([{ op: "write", path: "docs/late.md", text: "late" }], {
        etag: stale,
      });
      expect(res.status).toBe(412);
      expect(Object.keys(await storedTree())).not.toContain("docs/late.md");
    });
  });

  // ─── Authorization ─────────────────────────────────────────────────────────

  describe("authorization", () => {
    function keyHeaders(rawKey: string): Record<string, string> {
      return { Authorization: `Bearer ${rawKey}` };
    }

    async function keyWith(scopes: string[]): Promise<string> {
      const key = await seedApiKey({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        createdBy: ctx.user.id,
        scopes,
      });
      return key.rawKey;
    }

    it("403s a credential that can read skills but not write them", async () => {
      const res = await patchFiles([{ op: "write", path: "docs/a.md", text: "x" }], {
        etag: "*",
        headers: keyHeaders(await keyWith(["skills:read"])),
      });
      expect(res.status).toBe(403);
      expect(Object.keys(await storedTree())).not.toContain("docs/a.md");
    });

    it("403s a credential holding agents:write but not skills:write — the guard reads the row's type", async () => {
      const res = await patchFiles([{ op: "write", path: "docs/a.md", text: "x" }], {
        etag: "*",
        headers: keyHeaders(await keyWith(["agents:write", "skills:read"])),
      });
      expect(res.status).toBe(403);
      expect(Object.keys(await storedTree())).not.toContain("docs/a.md");
    });

    it("404s a package owned by another organization, even installed in this space", async () => {
      const other = await createTestContext({ orgSlug: "fwother" });
      const foreignId = "@fwother/private-skill";
      await seedPackage({
        id: foreignId,
        orgId: other.orgId,
        type: "skill",
        draftManifest: { ...skillManifest(), name: foreignId },
        draftContent: SKILL_MD,
      });
      await seedInstalledPackage(ctx.defaultSpaceId, foreignId);

      const res = await patchFiles([{ op: "write", path: "docs/a.md", text: "x" }], {
        etag: "*",
        id: foreignId,
      });
      expect(res.status).toBe(404);
    });

    it("403s a system package, whose tree the boot-time sync owns", async () => {
      const systemId = "@appstrate/system-skill";
      await seedPackage({
        id: systemId,
        orgId: null,
        source: "system",
        type: "skill",
        draftManifest: { ...skillManifest(), name: systemId },
        draftContent: SKILL_MD,
      });
      await uploadPackageFiles("skills", SYSTEM_STORAGE_NAMESPACE, systemId, {
        "SKILL.md": encoder.encode(SKILL_MD),
      });

      const res = await patchFiles([{ op: "write", path: "docs/a.md", text: "x" }], {
        etag: "*",
        id: systemId,
      });
      expect(res.status).toBe(403);
      const stored = await downloadPackageFiles(
        "skills",
        SYSTEM_STORAGE_NAMESPACE,
        systemId,
        undefined,
        "system",
      );
      expect(Object.keys(stored!)).toEqual(["SKILL.md"]);
    });

    it("401s without a credential", async () => {
      const res = await app.request(`/api/packages/${SKILL_ID}/files`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "If-Match": "*" },
        body: JSON.stringify({ operations: [{ op: "write", path: "docs/a.md", text: "x" }] }),
      });
      expect(res.status).toBe(401);
    });
  });
});
