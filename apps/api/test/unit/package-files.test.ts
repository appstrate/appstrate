// SPDX-License-Identifier: Apache-2.0

/**
 * Pure-logic half of the package file explorer: the per-type draft overlay,
 * media-kind classification, the inline budgets, index determinism, and ETag
 * stability. No DB, no storage — `readPackageSnapshot` is covered by the
 * integration suite.
 */

import { describe, it, expect } from "bun:test";
import type { PackageType } from "@appstrate/core/validation";
import { PACKAGE_FILE_INLINE_MAX_BYTES } from "@appstrate/core/package-files";
import {
  applyDraftOverlay,
  buildFileIndex,
  draftSnapshotId,
  indexEtag,
  fileEtag,
  resolveDraftContent,
  INDEX_JSON_BUDGET_BYTES,
  type PackageFileSnapshot,
  type PackageFileSource,
} from "../../src/services/package-files.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function snapshot(files: Record<string, Uint8Array | string>): PackageFileSnapshot {
  const normalized: Record<string, Uint8Array> = {};
  for (const [path, value] of Object.entries(files)) {
    normalized[path] = typeof value === "string" ? encoder.encode(value) : value;
  }
  return { files: normalized, snapshotId: "test" };
}

function entryFor(files: Record<string, Uint8Array | string>, path: string) {
  const entry = buildFileIndex(snapshot(files)).find((e) => e.path === path);
  expect(entry).toBeDefined();
  return entry!;
}

/**
 * Run the overlay over a stored-ZIP map and return it as plain text, so the
 * assertions read as "what the explorer will show".
 */
function overlay(
  type: PackageType,
  draft: { draftManifest?: unknown; draftContent?: string | null },
  stored: Record<string, string> = {},
): Record<string, string> {
  const files: Record<string, Uint8Array> = {};
  for (const [path, value] of Object.entries(stored)) files[path] = encoder.encode(value);

  const pkg: PackageFileSource = {
    id: "@t/pkg",
    type,
    orgId: "org",
    draftManifest: draft.draftManifest ?? null,
    draftContent: draft.draftContent ?? null,
  };
  applyDraftOverlay(files, pkg);

  return Object.fromEntries(
    Object.entries(files).map(([path, bytes]) => [path, decoder.decode(bytes)]),
  );
}

/**
 * `packages.draft_content` holds a DIFFERENT file per type — `PACKAGE_CONTENT_ENTRY`
 * (`@appstrate/core/package-files`), the same map `parsePackageZip` extracts the
 * column FROM. Overlaying it onto the wrong entry would either erase the
 * manifest or invent a file the package does not contain, so these cases pin
 * the whole matrix rather than trusting the shared declaration alone.
 *
 * The map's `required` flag decides the no-stored-ZIP case: a required entry is
 * materialized from the column alone, an optional one only lands on top of a
 * file that is already there. The table itself (every type present, each
 * classified) is pinned in `packages/core/test/package-files.test.ts`.
 */
describe("applyDraftOverlay — per-type draft_content target", () => {
  it("agent → prompt.md", () => {
    const files = overlay("agent", { draftContent: "the prompt" }, { "prompt.md": "STALE" });
    expect(files).toEqual({ "prompt.md": "the prompt" });
  });

  it("skill → SKILL.md", () => {
    const files = overlay("skill", { draftContent: "the skill" }, { "SKILL.md": "STALE" });
    expect(files).toEqual({ "SKILL.md": "the skill" });
  });

  it("integration → INTEGRATION.md, when the package actually has one", () => {
    const files = overlay(
      "integration",
      { draftContent: "# docs" },
      { "INTEGRATION.md": "STALE", "server/index.js": "code" },
    );
    expect(files).toEqual({ "INTEGRATION.md": "# docs", "server/index.js": "code" });
  });

  it("integration → nothing, when the package has no INTEGRATION.md", () => {
    // `parsePackageZip` falls back to the MANIFEST TEXT in that case;
    // materializing it would show a companion doc the bundle does not ship.
    const files = overlay(
      "integration",
      { draftContent: '{"name":"@t/pkg","type":"integration"}' },
      { "manifest.json": "{}", "server/index.js": "code" },
    );
    expect(Object.keys(files).sort()).toEqual(["manifest.json", "server/index.js"]);
    expect(files["manifest.json"]).toBe("{}");
  });

  it("integration → nothing, when draft_content is a manifest copy but the ZIP HAS a doc", () => {
    // The already-corrupted row. Every write path that fed the editor's
    // manifest JSON into `draft_content` left the real INTEGRATION.md sitting
    // intact in storage, so the overlay had a file to land on and served the
    // package's own manifest under the name of its documentation — the entry
    // the explorer pre-selects. No write-path fix can reach a row already in
    // this state; declining the overlay shows the stored truth instead.
    const files = overlay(
      "integration",
      { draftContent: '{\n  "name": "@t/pkg",\n  "type": "integration"\n}' },
      { "INTEGRATION.md": "# Real docs", "manifest.json": "{}" },
    );
    expect(files["INTEGRATION.md"]).toBe("# Real docs");
  });

  it("agent/skill are never sniffed — a JSON-shaped prompt still overlays", () => {
    // `required: true` means the column has no manifest-text fallback to be
    // confused with, so the manifest-copy test must not be applied there: a
    // prompt that happens to be a JSON object is still the prompt.
    const jsonish = '{"role": "you are a formatter"}';
    expect(overlay("agent", { draftContent: jsonish }, { "prompt.md": "STALE" })).toEqual({
      "prompt.md": jsonish,
    });
    expect(overlay("skill", { draftContent: jsonish }, { "SKILL.md": "STALE" })).toEqual({
      "SKILL.md": jsonish,
    });
  });

  it("mcp-server → nothing (draft_content is only a manifest copy)", () => {
    const files = overlay(
      "mcp-server",
      { draftContent: '{"name":"@t/pkg","type":"mcp-server"}' },
      { "manifest.json": "{}", "server/index.js": "code" },
    );
    expect(files).toEqual({ "manifest.json": "{}", "server/index.js": "code" });
  });

  it("materializes the agent/skill file even with no stored ZIP at all", () => {
    expect(overlay("agent", { draftContent: "p" })).toEqual({ "prompt.md": "p" });
    expect(overlay("skill", { draftContent: "s" })).toEqual({ "SKILL.md": "s" });
    // The two manifest-backed types must NOT gain a phantom entry.
    expect(overlay("integration", { draftContent: "x" })).toEqual({});
    expect(overlay("mcp-server", { draftContent: "x" })).toEqual({});
  });

  it("overlays draft_manifest onto manifest.json for every type", () => {
    for (const type of ["agent", "skill", "integration", "mcp-server"] as const) {
      const files = overlay(type, { draftManifest: { type } }, { "manifest.json": "STALE" });
      expect(JSON.parse(files["manifest.json"]!)).toEqual({ type });
    }
  });

  it("leaves the stored files untouched when both draft columns are null", () => {
    const stored = { "manifest.json": "{}", "prompt.md": "p" };
    expect(overlay("agent", {}, stored)).toEqual(stored);
  });
});

/**
 * The write-side guard, and the exact inverse of the overlay above: which
 * value a write whose `content` is a MANIFEST COPY may put in
 * `packages.draft_content`.
 *
 * Both package editors and the version-restore route feed one `content` field.
 * For `agent`/`skill` it IS the column's file. For `integration` it is the
 * manifest JSON while the column holds the optional `INTEGRATION.md`, so an
 * unguarded write destroyed the doc — the integration stopped contributing its
 * agent-facing documentation to every agent's platform prompt, and the file
 * explorer began serving manifest JSON under the name `INTEGRATION.md`.
 */
describe("resolveDraftContent — manifest-shaped writes never clobber a real doc", () => {
  const DOC = "# Real integration docs";
  const MANIFEST = '{\n  "name": "@t/pkg",\n  "type": "integration"\n}';

  it("keeps an integration's INTEGRATION.md over a manifest-shaped write", () => {
    expect(resolveDraftContent("integration", DOC, MANIFEST)).toBe(DOC);
  });

  it("REFRESHES the manifest-text fallback when the package ships no doc", () => {
    // An integration that legitimately has no INTEGRATION.md must keep a
    // CURRENT manifest copy — freezing the old one would make the column stale
    // relative to the manifest it mirrors.
    const older = '{"name":"@t/pkg","version":"1.0.0"}';
    expect(resolveDraftContent("integration", older, MANIFEST)).toBe(MANIFEST);
    expect(resolveDraftContent("integration", null, MANIFEST)).toBe(MANIFEST);
    expect(resolveDraftContent("integration", "", MANIFEST)).toBe(MANIFEST);
  });

  it("never guards a REQUIRED entry — the editor is prompt.md / SKILL.md's only author", () => {
    expect(resolveDraftContent("agent", "old prompt", "new prompt")).toBe("new prompt");
    expect(resolveDraftContent("skill", "old skill", "new skill")).toBe("new skill");
    // Including when the stored value is itself JSON-shaped: `required: true`
    // means there is no fallback for it to be confused with.
    expect(resolveDraftContent("agent", MANIFEST, "new prompt")).toBe("new prompt");
  });

  it("never guards mcp-server — its column is a manifest copy by definition", () => {
    expect(resolveDraftContent("mcp-server", MANIFEST, "anything")).toBe("anything");
  });
});

describe("buildFileIndex — media kind classification", () => {
  it("pins the inline ceiling to its literal", () => {
    // Every size assertion in this file is written in terms of the SYMBOL, so
    // raising the constant would keep this whole suite green while the value
    // silently moved. It cannot move silently: 1 MiB is baked into the
    // published OpenAPI description text ("Text files up to 1 MiB",
    // `apps/api/src/openapi/paths/packages.ts` and `openapi/schemas.ts`), so a
    // change here desynchronises the spec from the behaviour it documents.
    // The web side pins the same constant in
    // `apps/web/src/lib/test/package-file-tree.test.ts`.
    expect(PACKAGE_FILE_INLINE_MAX_BYTES).toBe(1_048_576);
  });

  it("classifies a UTF-8 file as text and inlines it verbatim", () => {
    const entry = entryFor({ "README.md": "# héllo\nwörld" }, "README.md");
    expect(entry.media_kind).toBe("text");
    expect(entry.inline).toBe("# héllo\nwörld");
    expect(entry.size).toBe(encoder.encode("# héllo\nwörld").byteLength);
  });

  it("classifies invalid UTF-8 as binary and never inlines it", () => {
    // Lone continuation byte + a truncated 3-byte sequence: not decodable
    // under a strict decoder, regardless of the (text-looking) extension.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x80, 0xe2, 0x28, 0xa1]);
    const entry = entryFor({ "looks-like.txt": bytes }, "looks-like.txt");
    expect(entry.media_kind).toBe("binary");
    expect(entry.inline).toBeUndefined();
  });

  it("keeps a leading BOM, so inline stays byte-faithful to size", () => {
    // A default TextDecoder strips U+FEFF: `inline` would then be neither the
    // full text nor a rendering of `size` bytes, and a client writing the
    // preview back would silently drop the BOM.
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("# title")]);
    const entry = entryFor({ "bom.md": bom }, "bom.md");
    expect(entry.media_kind).toBe("text");
    expect(entry.inline).toBe("﻿# title");
    expect(entry.size).toBe(bom.byteLength);
    expect(encoder.encode(entry.inline!).byteLength).toBe(entry.size);
  });

  it("treats a zero-byte file as text with an empty inline", () => {
    const entry = entryFor({ "empty.bin": new Uint8Array(0) }, "empty.bin");
    expect(entry.media_kind).toBe("text");
    expect(entry.inline).toBe("");
    expect(entry.size).toBe(0);
  });

  it("classifies an over-ceiling file by extension, without decoding it", () => {
    // Both files are the SAME bytes and both are undecodable. Only the
    // extension differs, which proves the >1 MiB branch never looked at
    // content: a content check would have called both of them binary.
    const huge = new Uint8Array(PACKAGE_FILE_INLINE_MAX_BYTES + 1).fill(0xff);
    const index = buildFileIndex(snapshot({ "big.md": huge, "big.bin": huge }));
    const md = index.find((e) => e.path === "big.md")!;
    const bin = index.find((e) => e.path === "big.bin")!;

    expect(md.media_kind).toBe("text");
    expect(bin.media_kind).toBe("binary");
    // Never inlined either way — an over-ceiling file has no preview.
    expect(md.inline).toBeUndefined();
    expect(bin.inline).toBeUndefined();
  });

  it("classifies a dotfile by its full base name", () => {
    const huge = new Uint8Array(PACKAGE_FILE_INLINE_MAX_BYTES + 1).fill(0xff);
    expect(entryFor({ ".gitignore": huge }, ".gitignore").media_kind).toBe("text");
    expect(entryFor({ blob: huge }, "blob").media_kind).toBe("binary");
  });

  it("classifies by extension on the base name, not the directory path", () => {
    const huge = new Uint8Array(PACKAGE_FILE_INLINE_MAX_BYTES + 1).fill(0xff);
    expect(entryFor({ "a.md/nested": huge }, "a.md/nested").media_kind).toBe("binary");
    expect(entryFor({ "a.bin/nested.md": huge }, "a.bin/nested.md").media_kind).toBe("text");
  });
});

describe("buildFileIndex — inline budgets", () => {
  it("does not inline a text file at the 1 MiB ceiling boundary + 1", () => {
    const atCeiling = "a".repeat(PACKAGE_FILE_INLINE_MAX_BYTES);
    const overCeiling = "a".repeat(PACKAGE_FILE_INLINE_MAX_BYTES + 1);
    expect(entryFor({ "at.txt": atCeiling }, "at.txt").inline).toBe(atCeiling);
    expect(entryFor({ "over.txt": overCeiling }, "over.txt").inline).toBeUndefined();
  });

  /**
   * Ground truth for "how many bytes of response body does this `inline` cost":
   * serialize it and encode the result. Deliberately NOT the formula the
   * implementation uses — that is what these tests are checking.
   */
  const serializedBytes = (text: string) => encoder.encode(JSON.stringify(text)).byteLength;

  it("charges a multi-byte inline its UTF-8 weight, not its UTF-16 length", () => {
    // U+4E2D: 1 UTF-16 code unit, 3 UTF-8 bytes. Nothing here is escaped, so
    // the serialized form is the raw bytes plus the two delimiting quotes.
    const cjk = "中".repeat(300_000);
    expect(cjk.length).toBe(300_000);
    expect(encoder.encode(cjk).byteLength).toBe(900_000);
    expect(serializedBytes(cjk)).toBe(900_002);
    // What `JSON.stringify(text).length` charges instead — 3× too little.
    expect(JSON.stringify(cjk).length).toBe(300_002);

    const index = buildFileIndex(snapshot({ "a.txt": cjk, "b.txt": cjk, "c.txt": cjk }));
    const inlined = index.filter((e) => e.inline !== undefined);

    // Two fit; a third would take the body to 2,700,006 B — 1.29× the 2 MiB
    // budget. UTF-16 accounting scored each file at 300,002 and inlined all
    // three, which is exactly the overrun the budget claims to prevent.
    expect(inlined.length).toBe(2);
    const weight = inlined.reduce((n, e) => n + serializedBytes(e.inline!), 0);
    expect(weight).toBe(1_800_004);
    expect(weight).toBeLessThanOrEqual(INDEX_JSON_BUDGET_BYTES);
    expect(weight + 900_002).toBeGreaterThan(INDEX_JSON_BUDGET_BYTES);
  });

  it("charges an astral-plane inline its UTF-8 weight, not its UTF-16 length", () => {
    // U+1F600 is a SURROGATE PAIR: 2 UTF-16 code units for 4 UTF-8 bytes. The
    // undercount is 2× here rather than 3×, and it is the case a
    // "count the units" fix would still get wrong.
    const emoji = "😀".repeat(200_000);
    expect(emoji.length).toBe(400_000);
    expect(encoder.encode(emoji).byteLength).toBe(800_000);
    expect(serializedBytes(emoji)).toBe(800_002);
    expect(JSON.stringify(emoji).length).toBe(400_002);

    const index = buildFileIndex(snapshot({ "a.txt": emoji, "b.txt": emoji, "c.txt": emoji }));
    const inlined = index.filter((e) => e.inline !== undefined);

    // Old accounting: 3 × 400,002 = 1,200,006 "budget bytes" → all three
    // inlined, for a 2,400,006-byte body.
    expect(inlined.length).toBe(2);
    const weight = inlined.reduce((n, e) => n + serializedBytes(e.inline!), 0);
    expect(weight).toBe(1_600_004);
    expect(weight).toBeLessThanOrEqual(INDEX_JSON_BUDGET_BYTES);
    expect(weight + 800_002).toBeGreaterThan(INDEX_JSON_BUDGET_BYTES);
  });

  it("counts escaping ON TOP of the multi-byte weight", () => {
    // Both terms at once, in 30k blocks of nine `中` (27 bytes, 9 units,
    // nothing escaped) plus one `"` (1 byte, 1 unit, escaped into two ASCII
    // bytes): 840,000 raw bytes that serialize to 870,002.
    const mixed = ("中".repeat(9) + '"').repeat(30_000);
    expect(mixed.length).toBe(300_000);
    expect(encoder.encode(mixed).byteLength).toBe(840_000);
    expect(serializedBytes(mixed)).toBe(870_002);
    expect(JSON.stringify(mixed).length).toBe(330_002);

    const index = buildFileIndex(snapshot({ "a.txt": mixed, "b.txt": mixed, "c.txt": mixed }));
    const inlined = index.filter((e) => e.inline !== undefined);

    // Two fit (1,740,004 B); a third would be 2,610,006 B. UTF-16 accounting
    // scored each file at 330,002 — it saw the escape but not the 3-byte
    // characters — and inlined all three.
    expect(inlined.length).toBe(2);
    const weight = inlined.reduce((n, e) => n + serializedBytes(e.inline!), 0);
    expect(weight).toBe(1_740_004);
    expect(weight).toBeLessThanOrEqual(INDEX_JSON_BUDGET_BYTES);
    expect(weight + 870_002).toBeGreaterThan(INDEX_JSON_BUDGET_BYTES);
  });

  it("charges escape expansion, not just the raw file size", () => {
    // Each char is 1 UTF-8 byte but serializes to 2 (`"` → `\"`), so the file
    // weighs ~2× its size once escaped. All three together are ~1.14 MiB of
    // raw bytes — comfortably under the 2 MiB budget — but ~2.3 MiB once
    // serialized. Raw-size accounting would therefore inline all three.
    const chunk = '"'.repeat(400_000);
    const files = { "a.txt": chunk, "b.txt": chunk, "c.txt": chunk };
    const index = buildFileIndex(snapshot(files));

    const totalRawBytes = index.reduce((n, e) => n + e.size, 0);
    expect(totalRawBytes).toBeLessThan(INDEX_JSON_BUDGET_BYTES);

    const inlined = index.filter((e) => e.inline !== undefined);
    expect(inlined.length).toBe(2);

    const weight = inlined.reduce((n, e) => n + serializedBytes(e.inline!), 0);
    expect(weight).toBe(1_600_004);
    expect(weight).toBeLessThanOrEqual(INDEX_JSON_BUDGET_BYTES);
    // …and one more would have blown past it.
    expect(weight + serializedBytes(chunk)).toBeGreaterThan(INDEX_JSON_BUDGET_BYTES);
  });

  it("still lists — with size and media_kind — the files that fell past the budget", () => {
    const chunk = "x".repeat(PACKAGE_FILE_INLINE_MAX_BYTES);
    const index = buildFileIndex(
      snapshot({ "a.txt": chunk, "b.txt": chunk, "c.txt": chunk, "d.txt": chunk }),
    );
    expect(index.length).toBe(4);
    const dropped = index.filter((e) => e.inline === undefined);
    expect(dropped.length).toBeGreaterThan(0);
    for (const entry of dropped) {
      expect(entry.media_kind).toBe("text");
      expect(entry.size).toBe(PACKAGE_FILE_INLINE_MAX_BYTES);
    }
  });

  it("never emits a truncated inline — inline is the whole file or absent", () => {
    const chunk = "x".repeat(PACKAGE_FILE_INLINE_MAX_BYTES);
    const index = buildFileIndex(
      snapshot({ "a.txt": chunk, "b.txt": chunk, "c.txt": chunk, "d.txt": chunk }),
    );
    for (const entry of index) {
      if (entry.inline !== undefined) {
        expect(encoder.encode(entry.inline).byteLength).toBe(entry.size);
      }
    }
  });
});

describe("buildFileIndex — determinism", () => {
  it("sorts entries by path regardless of insertion order", () => {
    const forward = buildFileIndex(snapshot({ "a.md": "1", "b/c.md": "2", "b/a.md": "3" }));
    const reverse = buildFileIndex(snapshot({ "b/a.md": "3", "b/c.md": "2", "a.md": "1" }));
    expect(forward.map((e) => e.path)).toEqual(["a.md", "b/a.md", "b/c.md"]);
    expect(forward).toEqual(reverse);
  });

  it("drops the same entries from the budget regardless of insertion order", () => {
    const chunk = "y".repeat(PACKAGE_FILE_INLINE_MAX_BYTES);
    const files = { "a.txt": chunk, "b.txt": chunk, "c.txt": chunk, "d.txt": chunk };
    const forward = buildFileIndex(snapshot(files));
    const reverse = buildFileIndex(
      snapshot(Object.fromEntries(Object.entries(files).reverse()) as typeof files),
    );
    expect(forward.map((e) => [e.path, e.inline !== undefined])).toEqual(
      reverse.map((e) => [e.path, e.inline !== undefined]),
    );
  });
});

describe("draftSnapshotId", () => {
  it("is stable for identical content, independent of key order", () => {
    const a = draftSnapshotId({ "a.md": encoder.encode("one"), "b.md": encoder.encode("two") });
    const b = draftSnapshotId({ "b.md": encoder.encode("two"), "a.md": encoder.encode("one") });
    expect(a).toBe(b);
  });

  it("changes when a single byte changes", () => {
    const before = draftSnapshotId({ "a.md": encoder.encode("hello") });
    const after = draftSnapshotId({ "a.md": encoder.encode("hellp") });
    expect(after).not.toBe(before);
  });

  it("changes when a file is added, removed, or renamed", () => {
    const base = { "a.md": encoder.encode("x") };
    const id = draftSnapshotId(base);
    expect(draftSnapshotId({ ...base, "b.md": encoder.encode("") })).not.toBe(id);
    expect(draftSnapshotId({})).not.toBe(id);
    expect(draftSnapshotId({ "renamed.md": encoder.encode("x") })).not.toBe(id);
  });

  it("folds the entry LENGTH in, so an entry boundary cannot be shifted", () => {
    // The case the length term actually defends. Both sides emit the identical
    // byte stream once path and content are concatenated WITHOUT the length:
    //   a \0 x  b \0 y   ==   a \0 x b \0 y
    // so deleting the length term from the digest makes these two collide.
    const twoFiles = { a: encoder.encode("x"), b: encoder.encode("y") };
    const oneFile = { a: encoder.encode("xb\0y") };
    expect(draftSnapshotId(twoFiles)).not.toBe(draftSnapshotId(oneFile));
  });

  it("is an UNQUOTED id — the ETag helpers add the quotes", () => {
    expect(draftSnapshotId({ "a.md": encoder.encode("x") })).toMatch(/^pd-[0-9a-f]{64}$/);
  });
});

/**
 * RFC 9110 §8.8.1 — an entity-tag identifies ONE representation. The index and
 * a file are different representations, and so are two files of the same
 * artifact (same URL, different `?path=`). A snapshot-wide tag would let a
 * validator obtained for file A produce a `304` for file B — or for a path
 * that does not exist at all.
 */
describe("indexEtag / fileEtag", () => {
  it("emits quoted strong validators", () => {
    expect(indexEtag("pd-abc")).toBe('"i-pd-abc"');
    expect(fileEtag("pd-abc", "a.md")).toMatch(/^"f-pd-abc-[0-9a-f]{32}"$/);
  });

  it("never lets an index tag match a file tag", () => {
    expect(indexEtag("pv-sha256-x")).not.toBe(fileEtag("pv-sha256-x", "a.md"));
  });

  it("distinguishes two paths within the same snapshot", () => {
    expect(fileEtag("pv-x", "a.md")).not.toBe(fileEtag("pv-x", "b.md"));
    expect(fileEtag("pv-x", "docs/a.md")).not.toBe(fileEtag("pv-x", "a.md"));
  });

  it("distinguishes the same path across two snapshots", () => {
    expect(fileEtag("pv-one", "a.md")).not.toBe(fileEtag("pv-two", "a.md"));
  });

  it("is stable for the same (snapshot, path) pair", () => {
    expect(fileEtag("pv-x", "a.md")).toBe(fileEtag("pv-x", "a.md"));
  });
});
