// SPDX-License-Identifier: Apache-2.0

/**
 * The pure half of the authoring loop: how a folder compares to a draft, which
 * bytes travel as text and which as base64, and which lock a working folder
 * carries. The HTTP half rides existing platform routes and was exercised
 * end to end against a live instance.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bumpPatch,
  chunk,
  diffFiles,
  frontmatterVersion,
  readLock,
  recordLock,
  toOperations,
  writeOperation,
} from "../src/lib/packages.ts";
import { lineDiff } from "../src/commands/packages.ts";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("diffFiles", () => {
  it("reports added, removed and modified files, sorted by path", () => {
    const local = { "SKILL.md": utf8("new"), "b.md": utf8("b") };
    const remote = { "SKILL.md": utf8("old"), "a.md": utf8("a") };
    expect(diffFiles(local, remote)).toEqual([
      { path: "a.md", kind: "removed" },
      { path: "b.md", kind: "added" },
      { path: "SKILL.md", kind: "modified" },
    ]);
  });

  it("counts a manifest-only edit as a change", () => {
    const local = { "manifest.json": utf8('{"name":"@a/b","version":"1.0.1"}') };
    const remote = { "manifest.json": utf8('{"name":"@a/b","version":"1.0.0"}') };
    expect(diffFiles(local, remote)).toEqual([{ path: "manifest.json", kind: "modified" }]);
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
    const op = writeOperation("pixel.png", bytes);
    expect(op).toEqual({
      op: "write",
      path: "pixel.png",
      bytes_base64: Buffer.from(bytes).toString("base64"),
    });
  });

  it("sends a leading BOM as base64, since decoding it as text would drop it", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
    expect("bytes_base64" in writeOperation("bom.txt", bytes)).toBe(true);
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
});

describe("chunk", () => {
  it("splits into batches of the given size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});

describe("versions", () => {
  it("bumps the patch", () => {
    expect(bumpPatch("1.2.3")).toBe("1.2.4");
    expect(bumpPatch("not-a-version")).toBe("1.0.0");
  });

  it("reads a version pinned in the frontmatter", () => {
    expect(frontmatterVersion("---\nname: a\nversion: 2.1.0\n---\nbody")).toBe("2.1.0");
    expect(frontmatterVersion("---\nname: a\n---\nversion: 2.1.0")).toBeUndefined();
  });
});

describe("locks per working folder", () => {
  const originalDataHome = process.env.XDG_DATA_HOME;
  let dataHome: string;

  beforeEach(async () => {
    dataHome = await mkdtemp(join(tmpdir(), "appstrate-cli-packages-"));
    process.env.XDG_DATA_HOME = dataHome;
  });

  afterEach(async () => {
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    await rm(dataHome, { recursive: true, force: true });
  });

  it("keeps one lock per folder, so two folders of one package do not share it", async () => {
    await recordLock("p", "/work/a", "@s/pkg", 2);
    await recordLock("p", "/work/b", "@s/pkg", 3);
    expect(await readLock("p", "/work/a", "@s/pkg")).toBe(2);
    expect(await readLock("p", "/work/b", "@s/pkg")).toBe(3);
  });

  it("forgets a folder's lock when it now holds another package", async () => {
    await recordLock("p", "/work/a", "@s/one", 2);
    expect(await readLock("p", "/work/a", "@s/two")).toBeUndefined();
  });

  it("keeps profiles apart", async () => {
    await recordLock("prod", "/work/a", "@s/pkg", 5);
    expect(await readLock("dev", "/work/a", "@s/pkg")).toBeUndefined();
  });
});
