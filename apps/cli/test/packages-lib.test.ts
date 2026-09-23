// SPDX-License-Identifier: Apache-2.0

/**
 * The pure half of the authoring loop: what a working folder is, how it
 * compares to a definition, which bytes travel as text and which as base64,
 * and which draft lock a folder carries. The HTTP half is exercised through the
 * commands in `packages-command.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  diffFiles,
  isIgnoredPath,
  readLock,
  readPackageFolder,
  readSpaceOf,
  recordLock,
  toOperations,
  writeOperation,
} from "../src/lib/packages.ts";
import { lineDiff } from "../src/commands/packages.ts";
import { splitPackageSpec } from "../src/lib/package-spec.ts";
import type { PackageHome } from "@appstrate/shared-types";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("splitPackageSpec", () => {
  it("splits <package>@<spec> past a scope's leading @", () => {
    expect(splitPackageSpec("@acme/pdf")).toEqual({ ref: "@acme/pdf" });
    expect(splitPackageSpec("pdf")).toEqual({ ref: "pdf" });
    expect(splitPackageSpec("@acme/pdf@1.2.0")).toEqual({ ref: "@acme/pdf", spec: "1.2.0" });
    expect(splitPackageSpec("@acme/pdf@^1.2")).toEqual({ ref: "@acme/pdf", spec: "^1.2" });
    expect(splitPackageSpec("pdf@latest")).toEqual({ ref: "pdf", spec: "latest" });
    expect(splitPackageSpec("@acme/pdf@draft")).toEqual({ ref: "@acme/pdf", spec: "draft" });
  });

  it("keeps everything after the first @ as the spec, for the server to judge", () => {
    expect(splitPackageSpec("@acme/pdf@1@2")).toEqual({ ref: "@acme/pdf", spec: "1@2" });
  });

  it("refuses an @ with nothing after it", () => {
    expect(() => splitPackageSpec("@acme/pdf@")).toThrow('nothing after "@"');
    expect(() => splitPackageSpec("pdf@")).toThrow('nothing after "@"');
  });
});

describe("isIgnoredPath", () => {
  it("ignores dot-named segments, tooling folders and the root signature", () => {
    for (const path of [
      ".git/config",
      ".env",
      "docs/.DS_Store",
      "src/.vscode/settings.json",
      "tools/__pycache__/a.pyc",
      "RECORD",
    ]) {
      expect(isIgnoredPath(path)).toBe(true);
    }
  });

  it("keeps ordinary files, including a RECORD that is not the root one", () => {
    // `node_modules` is package content: an MCP server bundle ships `server/node_modules`.
    for (const path of [
      "SKILL.md",
      "docs/RECORD",
      "a.b.md",
      "references/x.md",
      "server/node_modules/x/index.js",
    ]) {
      expect(isIgnoredPath(path)).toBe(false);
    }
  });
});

describe("diffFiles", () => {
  it("reports added, removed and modified files, in code-unit order", () => {
    const local = { "SKILL.md": utf8("new"), "b.md": utf8("b"), "Z.md": utf8("z") };
    const remote = { "SKILL.md": utf8("old"), "a.md": utf8("a"), "manifest.json": utf8("{}") };
    // Code units put upper case first: `S` < `Z` < `a` < `b`, whatever the locale.
    expect(diffFiles(local, remote)).toEqual([
      { path: "SKILL.md", kind: "modified" },
      { path: "Z.md", kind: "added" },
      { path: "a.md", kind: "removed" },
      { path: "b.md", kind: "added" },
    ]);
  });

  it("leaves ignored paths out on both sides, so a remote dotfile is never deleted", () => {
    const local = { "SKILL.md": utf8("x"), ".env": utf8("SECRET=1") };
    const remote = {
      "SKILL.md": utf8("x"),
      ".editorconfig": utf8("root = true"),
      RECORD: utf8(""),
    };
    expect(diffFiles(local, remote)).toEqual([]);
  });

  it("counts a manifest-only edit as a change when the folder authors the manifest", () => {
    const local = { "manifest.json": utf8('{"name":"@a/b","version":"1.0.1"}') };
    const remote = { "manifest.json": utf8('{"name":"@a/b","version":"1.0.0"}') };
    expect(diffFiles(local, remote)).toEqual([{ path: "manifest.json", kind: "modified" }]);
  });

  it("does not compare the manifest of a folder that has none", () => {
    const local = { "SKILL.md": utf8("x") };
    const remote = { "SKILL.md": utf8("x"), "manifest.json": utf8('{"name":"@a/b"}') };
    expect(diffFiles(local, remote)).toEqual([]);
  });

  it("matches paths in NFC, keeping the draft's spelling for what it writes and deletes", () => {
    const nfd = "Cafe\u0301.md";
    const local = { "Caf\u00e9.md": utf8("mine"), "SKILL.md": utf8("x") };
    const remote = { [nfd]: utf8("theirs"), "SKILL.md": utf8("x"), "old\u0301.md": utf8("o") };
    const changes = diffFiles(local, remote);
    expect(changes).toEqual([
      { path: nfd, kind: "modified", localPath: "Caf\u00e9.md" },
      { path: "old\u0301.md", kind: "removed" },
    ]);
    expect(toOperations(changes, local)).toEqual([
      { op: "write", path: nfd, text: "mine" },
      { op: "delete", path: "old\u0301.md" },
    ]);
  });

  it("compares manifests as JSON, so key order and indentation are not changes", () => {
    const local = { "manifest.json": utf8('{\n  "version": "1.0.0",\n  "name": "@a/b"\n}\n') };
    const remote = { "manifest.json": utf8('{"name":"@a/b","version":"1.0.0"}') };
    expect(diffFiles(local, remote)).toEqual([]);
  });
});

describe("writeOperation", () => {
  it("sends UTF-8 text as text", () => {
    expect(writeOperation("a.md", utf8("héllo"))).toEqual({
      op: "write",
      path: "a.md",
      text: "héllo",
    });
  });

  it("sends bytes that are not valid UTF-8 as base64, byte for byte", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]);
    expect(writeOperation("pixel.png", bytes)).toEqual({
      op: "write",
      path: "pixel.png",
      bytes_base64: Buffer.from(bytes).toString("base64"),
    });
  });

  it("keeps a leading BOM in the text, by the platform's own decoding rule", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    expect(writeOperation("bom.txt", bytes)).toEqual({
      op: "write",
      path: "bom.txt",
      text: "\uFEFFa",
    });
  });
});

describe("toOperations", () => {
  it("never writes manifest.json as a file: it travels as the manifest field", () => {
    const local = { "manifest.json": utf8("{}"), "SKILL.md": utf8("x") };
    const ops = toOperations(
      [
        { path: "SKILL.md", kind: "modified" },
        { path: "manifest.json", kind: "modified" },
        { path: "old.md", kind: "removed" },
      ],
      local,
    );
    expect(ops).toEqual([
      { op: "write", path: "SKILL.md", text: "x" },
      { op: "delete", path: "old.md" },
    ]);
  });
});

describe("lineDiff", () => {
  it("marks kept, removed and added lines", () => {
    expect(lineDiff(["a", "b", "c"], ["a", "x", "c"])).toEqual(["  a", "- b", "+ x", "  c"]);
  });

  it("summarises instead of building a table past the cap", () => {
    const a = Array.from({ length: 2001 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 2001 }, (_, i) => `b${i}`);
    expect(lineDiff(a, b)).toEqual(["  diff too large: 2001 → 2001 lines"]);
  });
});

describe("readSpaceOf", () => {
  const home = (overrides: Partial<PackageHome>): PackageHome => ({
    id: "@a/b",
    type: "skill",
    home_space_id: "spc_home",
    home_writable: false,
    home_deletable: false,
    home_shareable: false,
    read_space_ids: ["spc_home", "spc_team"],
    ...overrides,
  });

  it("reads a writer's package in its home", () => {
    expect(readSpaceOf(home({ home_writable: true }), "spc_team")).toBe("spc_home");
  });

  it("reads a reader's package in the pinned space when that space reads it", () => {
    expect(readSpaceOf(home({}), "spc_team")).toBe("spc_team");
  });

  it("falls back to the first reading space, a withheld home included", () => {
    expect(readSpaceOf(home({ home_space_id: null, read_space_ids: ["spc_x"] }), "spc_y")).toBe(
      "spc_x",
    );
  });
});

describe("working folders", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "appstrate-cli-packages-folder-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads files by NFC path, node_modules included, and never reads ignored entries", async () => {
    await writeFile(join(dir, "SKILL.md"), "x");
    await writeFile(join(dir, "Cafe\u0301.md"), "decomposed");
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "HEAD"), "ref");
    await writeFile(join(dir, ".env"), "SECRET=1");
    await mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await writeFile(join(dir, "node_modules", "x", "i.js"), "");

    const files = await readPackageFolder(dir);

    expect(Object.keys(files).sort()).toEqual(["Caf\u00e9.md", "SKILL.md", "node_modules/x/i.js"]);
  });

  it("refuses a path no package can carry, naming it", async () => {
    await writeFile(join(dir, "SKILL.md"), "x");
    await writeFile(join(dir, "sales,2024.csv"), "a,b");
    await expect(readPackageFolder(dir)).rejects.toThrow("sales,2024.csv");
  });

  it("reads a file over the per-file write limit: only a write of it is refused", async () => {
    await writeFile(join(dir, "SKILL.md"), "x");
    await writeFile(join(dir, "big.bin"), new Uint8Array(1_048_577));
    const files = await readPackageFolder(dir);
    expect(files["big.bin"]?.byteLength).toBe(1_048_577);

    expect(() => toOperations([{ path: "big.bin", kind: "modified" }], files)).toThrow(
      /big\.bin.*1 MiB/,
    );
    expect(toOperations([{ path: "big.bin", kind: "removed" }], files)).toEqual([
      { op: "delete", path: "big.bin" },
    ]);
  });

  it("refuses a symbolic link instead of skipping it", async () => {
    await writeFile(join(dir, "SKILL.md"), "x");
    await symlink(join(dir, "SKILL.md"), join(dir, "alias.md"));
    await expect(readPackageFolder(dir)).rejects.toThrow(/alias\.md.*symbolic link/);
  });

  it("needs manifest.json or SKILL.md at the top level", async () => {
    await writeFile(join(dir, "notes.md"), "x");
    await expect(readPackageFolder(dir)).rejects.toThrow(/neither manifest\.json nor SKILL\.md/);
  });
});

describe("locks per working folder", () => {
  const originalDataHome = process.env.XDG_DATA_HOME;
  let dataHome: string;
  let work: string;

  beforeEach(async () => {
    dataHome = await mkdtemp(join(tmpdir(), "appstrate-cli-packages-data-"));
    work = await mkdtemp(join(tmpdir(), "appstrate-cli-packages-work-"));
    await mkdir(join(work, "a"));
    await mkdir(join(work, "b"));
    process.env.XDG_DATA_HOME = dataHome;
  });

  afterEach(async () => {
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    await rm(dataHome, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  it("keeps one lock per folder, so two folders of one package do not share it", async () => {
    await recordLock("p", join(work, "a"), "@s/pkg", 2);
    await recordLock("p", join(work, "b"), "@s/pkg", 3);
    expect(await readLock("p", join(work, "a"), "@s/pkg")).toBe(2);
    expect(await readLock("p", join(work, "b"), "@s/pkg")).toBe(3);
  });

  it("forgets a folder's lock when it now holds another package", async () => {
    await recordLock("p", join(work, "a"), "@s/one", 2);
    expect(await readLock("p", join(work, "a"), "@s/two")).toBeUndefined();
  });

  it("keeps profiles apart", async () => {
    await recordLock("prod", join(work, "a"), "@s/pkg", 5);
    expect(await readLock("dev", join(work, "a"), "@s/pkg")).toBeUndefined();
  });

  it("finds a folder by its real path, whatever spelling reached it", async () => {
    await symlink(join(work, "a"), join(work, "link"));
    await recordLock("p", join(work, "link"), "@s/pkg", 7);
    expect(await readLock("p", join(work, "a", "..", "a"), "@s/pkg")).toBe(7);
  });

  it("refuses a lock table it cannot parse instead of starting over", async () => {
    const path = join(dataHome, "appstrate", "packages", "p-locks.json");
    await mkdir(join(dataHome, "appstrate", "packages"), { recursive: true });
    await writeFile(path, "{ not json");

    await expect(readLock("p", join(work, "a"), "@s/pkg")).rejects.toThrow(
      /not a valid packages lock table/,
    );
    await expect(recordLock("p", join(work, "a"), "@s/pkg", 1)).rejects.toThrow(
      /not a valid packages lock table/,
    );
    expect(await readFile(path, "utf-8")).toBe("{ not json");
  });

  it("loses no entry when two writers record at once", async () => {
    await Promise.all([
      recordLock("p", join(work, "a"), "@s/one", 1),
      recordLock("p", join(work, "b"), "@s/two", 2),
    ]);
    expect(await readLock("p", join(work, "a"), "@s/one")).toBe(1);
    expect(await readLock("p", join(work, "b"), "@s/two")).toBe(2);
  });
});
