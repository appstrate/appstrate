// SPDX-License-Identifier: Apache-2.0

/**
 * The file explorer's pure core.
 *
 * Everything asserted here is what a rendered test cannot reach: the tree is
 * virtualized, so a DOM-less render emits zero rows and the ARIA bookkeeping
 * (`aria-level` / `aria-setsize` / `aria-posinset`, all computed by hand
 * precisely BECAUSE rows are windowed) would go unverified.
 */

import { describe, it, expect } from "bun:test";
import { PACKAGE_FILE_INLINE_MAX_BYTES } from "@appstrate/core/package-files";
import {
  baseName,
  buildFileTree,
  flattenVisibleRows,
  isPreviewable,
  languageForPath,
  nextTreeFocus,
  pickActiveEntry,
  previewBlockReason,
  type PackageFileEntry,
  type TreeNode,
} from "../package-file-tree.ts";

function file(path: string, over: Partial<PackageFileEntry> = {}): PackageFileEntry {
  return { path, size: 12, media_kind: "text", ...over };
}

/** Compact `kind:path` shape of a node list, for readable assertions. */
function shape(nodes: TreeNode[]): string[] {
  return nodes.map((n) =>
    n.kind === "dir" ? `dir:${n.path}[${shape(n.children).join(",")}]` : `file:${n.path}`,
  );
}

/** Everything open — the explorer's default. */
const NONE_COLLAPSED: ReadonlySet<string> = new Set();

describe("buildFileTree", () => {
  it("keeps root files at the root and synthesizes directories from segments", () => {
    const tree = buildFileTree([file("manifest.json"), file("prompt.md"), file("skills/a.md")]);

    // Directories first, then files — each group by name.
    expect(shape(tree)).toEqual([
      "dir:skills[file:skills/a.md]",
      "file:manifest.json",
      "file:prompt.md",
    ]);
  });

  it("nests deep paths, reusing each directory across the entries under it", () => {
    const tree = buildFileTree([
      file("skills/deep/nested/one.md"),
      file("skills/deep/nested/two.md"),
      file("skills/deep/other.md"),
    ]);

    expect(shape(tree)).toEqual([
      "dir:skills[dir:skills/deep[dir:skills/deep/nested[file:skills/deep/nested/one.md,file:skills/deep/nested/two.md],file:skills/deep/other.md]]",
    ]);
    // A directory is never an entry of its own.
    const skills = tree[0]!;
    expect(skills.kind).toBe("dir");
    expect(skills).not.toHaveProperty("entry");
  });

  it("keeps a directory and a file that share a name prefix apart", () => {
    const tree = buildFileTree([file("skills.md"), file("skills/a.md")]);

    expect(shape(tree)).toEqual(["dir:skills[file:skills/a.md]", "file:skills.md"]);
  });

  it("produces the same tree whatever order the entries arrive in", () => {
    const entries = [file("b/z.md"), file("a.md"), file("b/a.md"), file("c.md")];
    const forward = shape(buildFileTree(entries));
    const reversed = shape(buildFileTree([...entries].reverse()));

    expect(reversed).toEqual(forward);
    expect(forward).toEqual(["dir:b[file:b/a.md,file:b/z.md]", "file:a.md", "file:c.md"]);
  });

  it("carries the index entry on every file node", () => {
    const entry = file("logo.png", { size: 900, media_kind: "binary" });
    const [node] = buildFileTree([entry]);

    expect(node).toEqual({
      kind: "file",
      id: "file:logo.png",
      path: "logo.png",
      name: "logo.png",
      entry,
    });
  });

  it("skips an entry whose path is nothing but separators", () => {
    const tree = buildFileTree([file("/"), file("//"), file("a.md")]);

    expect(shape(tree)).toEqual(["file:a.md"]);
  });

  it("builds a deep path iteratively, without overflowing the stack", () => {
    // Segment counts are attacker-controlled: a crafted ZIP entry name is all
    // it takes, and a recursive walk would blank the Files tab for the org.
    const depth = 20_000;
    const tree = buildFileTree([file(`${"a/".repeat(depth)}deep.md`)]);
    const rows = flattenVisibleRows(tree, NONE_COLLAPSED);

    expect(rows).toHaveLength(depth + 1);
    expect(rows[depth]!.depth).toBe(depth);
    expect(rows[depth]!.node.name).toBe("deep.md");
  });
});

/**
 * Identity is the fix for a real collision: `path` is not unique across a tree,
 * and keying focus / selection / the roving tabindex off it makes the arrows,
 * Enter and `tabIndex={0}` address two rows at once.
 */
describe("node identity", () => {
  it("separates a file and a directory that occupy the same path", () => {
    const tree = buildFileTree([file("docs"), file("docs/a.md")]);
    const rows = flattenVisibleRows(tree, NONE_COLLAPSED);

    expect(rows.map((r) => r.node.path)).toEqual(["docs", "docs/a.md", "docs"]);
    // Same path, different identity — this is what every consumer keys off.
    expect(rows.map((r) => r.node.id)).toEqual(["dir:docs", "file:docs/a.md", "file:docs"]);
    expect(new Set(rows.map((r) => r.node.id)).size).toBe(rows.length);
  });

  it("separates duplicate entries for one path", () => {
    // A hand-crafted archive can carry the same name twice.
    const rows = flattenVisibleRows(
      buildFileTree([file("dup.md"), file("dup.md")]),
      NONE_COLLAPSED,
    );

    expect(rows.map((r) => r.node.id)).toEqual(["file:dup.md", "file:dup.md#2"]);
  });

  it("stays stable across rebuilds, so a refetch keeps focus and selection", () => {
    const entries = [file("docs"), file("docs/a.md"), file("prompt.md")];
    const ids = (list: readonly PackageFileEntry[]) =>
      flattenVisibleRows(buildFileTree(list), NONE_COLLAPSED).map((r) => r.node.id);

    expect(ids(entries.map((e) => ({ ...e })))).toEqual(ids(entries));
  });
});

describe("flattenVisibleRows", () => {
  const tree = buildFileTree([
    file("skills/deep/one.md"),
    file("skills/two.md"),
    file("manifest.json"),
    file("prompt.md"),
  ]);

  it("shows everything when nothing is collapsed", () => {
    const rows = flattenVisibleRows(tree, NONE_COLLAPSED);

    expect(rows.map((r) => r.node.path)).toEqual([
      "skills",
      "skills/deep",
      "skills/deep/one.md",
      "skills/two.md",
      "manifest.json",
      "prompt.md",
    ]);
    expect(rows[0]!.expanded).toBe(true);
  });

  it("hides the contents of a collapsed directory", () => {
    const rows = flattenVisibleRows(tree, new Set(["skills"]));

    expect(rows.map((r) => r.node.path)).toEqual(["skills", "manifest.json", "prompt.md"]);
    expect(rows[0]!.expanded).toBe(false);
    // Files never report themselves as expanded.
    expect(rows[1]!.expanded).toBe(false);
  });

  it("collapses only the directory named, not its ancestors", () => {
    const rows = flattenVisibleRows(tree, new Set(["skills/deep"]));

    expect(rows.map((r) => r.node.path)).toEqual([
      "skills",
      "skills/deep",
      "skills/two.md",
      "manifest.json",
      "prompt.md",
    ]);
    expect(rows[0]!.expanded).toBe(true);
    expect(rows[1]!.expanded).toBe(false);
  });

  it("computes level, set size and position per sibling group", () => {
    const rows = flattenVisibleRows(tree, NONE_COLLAPSED);
    const aria = rows.map((r) => [r.node.path, r.depth, r.setSize, r.posInSet]);

    expect(aria).toEqual([
      // Root group: skills, manifest.json, prompt.md → 3 siblings.
      ["skills", 0, 3, 1],
      // Inside `skills`: deep, two.md → 2 siblings, one level deeper.
      ["skills/deep", 1, 2, 1],
      ["skills/deep/one.md", 2, 1, 1],
      ["skills/two.md", 1, 2, 2],
      ["manifest.json", 0, 3, 2],
      ["prompt.md", 0, 3, 3],
    ]);
  });

  it("returns nothing for an empty tree", () => {
    expect(flattenVisibleRows([], NONE_COLLAPSED)).toEqual([]);
    expect(flattenVisibleRows(buildFileTree([]), NONE_COLLAPSED)).toEqual([]);
  });

  it("reports a lone row as a set of one", () => {
    const rows = flattenVisibleRows(buildFileTree([file("prompt.md")]), NONE_COLLAPSED);

    expect(rows).toHaveLength(1);
    expect([rows[0]!.depth, rows[0]!.setSize, rows[0]!.posInSet]).toEqual([0, 1, 1]);
    expect(rows[0]!.expanded).toBe(false);
  });
});

describe("nextTreeFocus", () => {
  // skills/ → skills/deep/ (collapsed) → skills/two.md, manifest.json
  const tree = buildFileTree([
    file("skills/deep/one.md"),
    file("skills/two.md"),
    file("manifest.json"),
  ]);
  const rows = flattenVisibleRows(tree, new Set(["skills/deep"]));

  it("lays out the fixture as expected", () => {
    expect(rows.map((r) => r.node.id)).toEqual([
      "dir:skills",
      "dir:skills/deep",
      "file:skills/two.md",
      "file:manifest.json",
    ]);
  });

  it("moves down and up one row at a time", () => {
    expect(nextTreeFocus(rows, "dir:skills", "ArrowDown")).toEqual({
      type: "focus",
      id: "dir:skills/deep",
    });
    expect(nextTreeFocus(rows, "file:skills/two.md", "ArrowUp")).toEqual({
      type: "focus",
      id: "dir:skills/deep",
    });
  });

  it("stops at the list boundaries instead of wrapping", () => {
    expect(nextTreeFocus(rows, "file:manifest.json", "ArrowDown")).toBeNull();
    expect(nextTreeFocus(rows, "dir:skills", "ArrowUp")).toBeNull();
  });

  it("enters the list when nothing is focused yet", () => {
    expect(nextTreeFocus(rows, null, "ArrowDown")).toEqual({ type: "focus", id: "dir:skills" });
    expect(nextTreeFocus(rows, null, "ArrowUp")).toEqual({
      type: "focus",
      id: "file:manifest.json",
    });
    expect(nextTreeFocus(rows, null, "ArrowLeft")).toBeNull();
    expect(nextTreeFocus(rows, null, "ArrowRight")).toBeNull();
  });

  it("jumps to the first and last rows on Home / End", () => {
    expect(nextTreeFocus(rows, "file:skills/two.md", "Home")).toEqual({
      type: "focus",
      id: "dir:skills",
    });
    expect(nextTreeFocus(rows, "dir:skills", "End")).toEqual({
      type: "focus",
      id: "file:manifest.json",
    });
  });

  it("expands a collapsed directory on ArrowRight, then descends into it", () => {
    expect(nextTreeFocus(rows, "dir:skills/deep", "ArrowRight")).toEqual({
      type: "expand",
      id: "dir:skills/deep",
    });
    // Same row once open: the first child is the next visible row.
    const opened = flattenVisibleRows(tree, NONE_COLLAPSED);
    expect(nextTreeFocus(opened, "dir:skills/deep", "ArrowRight")).toEqual({
      type: "focus",
      id: "file:skills/deep/one.md",
    });
  });

  it("does nothing on ArrowRight over a file", () => {
    expect(nextTreeFocus(rows, "file:manifest.json", "ArrowRight")).toBeNull();
  });

  it("collapses an open directory on ArrowLeft, then leaves for its parent", () => {
    expect(nextTreeFocus(rows, "dir:skills", "ArrowLeft")).toEqual({
      type: "collapse",
      id: "dir:skills",
    });
    // Collapsed directory / first child: ArrowLeft walks up instead.
    expect(nextTreeFocus(rows, "dir:skills/deep", "ArrowLeft")).toEqual({
      type: "focus",
      id: "dir:skills",
    });
    expect(nextTreeFocus(rows, "file:skills/two.md", "ArrowLeft")).toEqual({
      type: "focus",
      id: "dir:skills",
    });
  });

  it("has nowhere to go on ArrowLeft from a root-level row", () => {
    expect(nextTreeFocus(rows, "file:manifest.json", "ArrowLeft")).toBeNull();
  });

  it("type-ahead jumps to the next matching name and wraps around", () => {
    expect(nextTreeFocus(rows, "dir:skills", "m")).toEqual({
      type: "focus",
      id: "file:manifest.json",
    });
    // From the last row, "s" wraps to the top.
    expect(nextTreeFocus(rows, "file:manifest.json", "s")).toEqual({
      type: "focus",
      id: "dir:skills",
    });
    // Case-insensitive, and matches on the base name — not the full path.
    expect(nextTreeFocus(rows, "file:manifest.json", "D")).toEqual({
      type: "focus",
      id: "dir:skills/deep",
    });
  });

  it("ignores keys it does not model", () => {
    expect(nextTreeFocus(rows, "dir:skills", " ")).toBeNull();
    expect(nextTreeFocus(rows, "dir:skills", "Escape")).toBeNull();
    expect(nextTreeFocus(rows, "dir:skills", "q")).toBeNull();
  });

  it("does nothing at all on an empty tree", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "a"]) {
      expect(nextTreeFocus([], null, key)).toBeNull();
    }
  });

  /**
   * The collision the whole `id` scheme exists for. Keyed by path, every one of
   * these resolved to the DIRECTORY at index 0 and moved, collapsed or toggled
   * the wrong row.
   */
  it("acts on the row the user is on when a file and a directory share a path", () => {
    const collided = flattenVisibleRows(
      buildFileTree([file("docs"), file("docs/a.md")]),
      NONE_COLLAPSED,
    );
    expect(collided.map((r) => r.node.id)).toEqual(["dir:docs", "file:docs/a.md", "file:docs"]);

    // The FILE `docs` is the last row: there is nothing below it.
    expect(nextTreeFocus(collided, "file:docs", "ArrowDown")).toBeNull();
    // It is a root-level file, so ArrowLeft has no parent to reach — and must
    // certainly not collapse the unrelated directory of the same name.
    expect(nextTreeFocus(collided, "file:docs", "ArrowLeft")).toBeNull();
    // The directory row still behaves like a directory.
    expect(nextTreeFocus(collided, "dir:docs", "ArrowLeft")).toEqual({
      type: "collapse",
      id: "dir:docs",
    });
    expect(nextTreeFocus(collided, "dir:docs", "ArrowDown")).toEqual({
      type: "focus",
      id: "file:docs/a.md",
    });
  });
});

describe("pickActiveEntry", () => {
  const entries = [file("manifest.json"), file("prompt.md"), file("skills/a.md")];

  it("honours the user's selection while the file still exists", () => {
    expect(pickActiveEntry(entries, "skills/a.md", "prompt.md")?.path).toBe("skills/a.md");
  });

  it("falls back to the type's primary file when nothing is selected", () => {
    expect(pickActiveEntry(entries, null, "prompt.md")?.path).toBe("prompt.md");
  });

  it("falls back when a version switch dropped the selected file", () => {
    expect(pickActiveEntry(entries, "gone.md", "prompt.md")?.path).toBe("prompt.md");
  });

  it("falls back to the first entry when the primary file is absent", () => {
    expect(pickActiveEntry(entries, null, "SKILL.md")?.path).toBe("manifest.json");
    expect(pickActiveEntry(entries, "gone.md", "SKILL.md")?.path).toBe("manifest.json");
  });

  it("reports an empty archive as having nothing to show", () => {
    expect(pickActiveEntry([], null, "prompt.md")).toBeNull();
    expect(pickActiveEntry([], "prompt.md", "prompt.md")).toBeNull();
  });
});

/**
 * The preview verdict AND the reason shown to the user. This is the whole of
 * what the preview panel decides — the component renders `previewBlockReason`
 * and holds no rule of its own.
 */
describe("previewBlockReason", () => {
  it("pins the ceiling to the server's inline limit", () => {
    // Without the literal, every boundary assertion below is trivially true for
    // whatever value the constant happens to hold. The value is also a wire
    // contract: it is written out in the published OpenAPI description text
    // ("Text files up to 1 MiB", `apps/api/src/openapi/paths/packages.ts` and
    // `openapi/schemas.ts`), so moving it without touching the spec would
    // desynchronise the two.
    expect(PACKAGE_FILE_INLINE_MAX_BYTES).toBe(1_048_576);
  });

  it("clears text below the ceiling, including an empty file", () => {
    expect(previewBlockReason(file("a.md", { size: 0 }))).toBeNull();
    expect(previewBlockReason(file("a.md", { size: 12 }))).toBeNull();
  });

  it("treats the ceiling as inclusive, matching the server's `size <= PACKAGE_FILE_INLINE_MAX_BYTES`", () => {
    expect(previewBlockReason(file("a.md", { size: 1_048_576 }))).toBeNull();
    expect(previewBlockReason(file("a.md", { size: 1_048_575 }))).toBeNull();
    expect(previewBlockReason(file("a.md", { size: 1_048_577 }))).toBe("too_large");
  });

  it("reports binary as binary at every size the server actually inspected", () => {
    // At or below the ceiling the server decoded the bytes, so `binary` is a
    // checked fact and the more useful one — shrinking the file would not make
    // it previewable.
    for (const size of [0, 12, PACKAGE_FILE_INLINE_MAX_BYTES]) {
      expect(previewBlockReason(file("logo.png", { media_kind: "binary", size }))).toBe("binary");
    }
  });

  it("says too large, not binary, above the ceiling — the server only guessed there", () => {
    // Over 1 MiB the server classifies by EXTENSION without decoding
    // (`services/package-files.ts`), so an extension-less text file comes back
    // `binary`. Reporting that verbatim told the user a 1.5 MB CHANGELOG was
    // a binary file.
    expect(previewBlockReason(file("CHANGELOG", { media_kind: "binary", size: 1_572_864 }))).toBe(
      "too_large",
    );
    expect(previewBlockReason(file("LICENSE", { media_kind: "binary", size: 1_048_577 }))).toBe(
      "too_large",
    );
    // Same answer for a file that really is binary: above the ceiling size is
    // the binding constraint either way, so the verdict does not depend on a
    // classification nobody verified.
    for (const size of [PACKAGE_FILE_INLINE_MAX_BYTES + 1, 50_000_000]) {
      expect(previewBlockReason(file("logo.png", { media_kind: "binary", size }))).toBe(
        "too_large",
      );
    }
  });

  it("keeps the two reasons distinct — the panel shows a different message for each", () => {
    const binary = previewBlockReason(file("logo.png", { media_kind: "binary", size: 8_192 }));
    const tooLarge = previewBlockReason(
      file("dump.html", { size: PACKAGE_FILE_INLINE_MAX_BYTES + 1 }),
    );
    expect(binary).toBe("binary");
    expect(tooLarge).toBe("too_large");
    expect(binary).not.toBe(tooLarge);
  });

  it("does not depend on `inline` in either direction", () => {
    expect(previewBlockReason(file("a.md"))).toBeNull();
    expect(previewBlockReason(file("a.md", { inline: "hello" }))).toBeNull();
    // `inline` above the ceiling is impossible on the wire; the verdict gates
    // on size regardless, so handing the component bytes cannot unblock it.
    expect(
      previewBlockReason(
        file("dump.html", {
          size: PACKAGE_FILE_INLINE_MAX_BYTES + 1,
          inline: "<script>alert(1)</script>",
        }),
      ),
    ).toBe("too_large");
  });
});

describe("isPreviewable", () => {
  it("is exactly `previewBlockReason() === null`", () => {
    const cases = [
      file("a.md", { size: 0 }),
      file("a.md", { size: PACKAGE_FILE_INLINE_MAX_BYTES }),
      file("a.md", { size: PACKAGE_FILE_INLINE_MAX_BYTES + 1 }),
      file("logo.png", { media_kind: "binary" }),
      file("logo.png", { media_kind: "binary", size: PACKAGE_FILE_INLINE_MAX_BYTES + 1 }),
    ];
    for (const entry of cases) {
      expect(isPreviewable(entry)).toBe(previewBlockReason(entry) === null);
    }
    expect(cases.map(isPreviewable)).toEqual([true, true, false, false, false]);
  });
});

describe("languageForPath", () => {
  it("maps the extensions package artifacts actually contain", () => {
    const cases: Record<string, string> = {
      "prompt.md": "markdown",
      "manifest.json": "json",
      "src/index.ts": "typescript",
      "src/App.tsx": "typescript",
      "src/index.js": "javascript",
      "src/App.jsx": "javascript",
      "tool.py": "python",
      "entrypoint.sh": "shell",
      "compose.yaml": "yaml",
      "compose.yml": "yaml",
      "styles.css": "css",
      "index.html": "html",
      "feed.xml": "xml",
      "logo.svg": "xml",
      "seed.sql": "sql",
      "config.toml": "ini",
    };
    for (const [path, language] of Object.entries(cases)) {
      expect(languageForPath(path)).toBe(language);
    }
  });

  it("is case-insensitive on the extension", () => {
    expect(languageForPath("README.MD")).toBe("markdown");
  });

  it("falls back to plain text for anything unknown", () => {
    expect(languageForPath("Dockerfile")).toBe("plaintext");
    expect(languageForPath(".gitignore")).toBe("plaintext");
    expect(languageForPath("archive.tar.gz")).toBe("plaintext");
    expect(languageForPath("bin/runner")).toBe("plaintext");
  });

  it("reads the extension off the base name, not a directory further up", () => {
    // `src.md/notes` must not be markdown.
    expect(languageForPath("src.md/notes")).toBe("plaintext");
    expect(languageForPath("a.py/b.ts")).toBe("typescript");
  });
});

describe("baseName", () => {
  it("returns the last segment — the preview title and the download filename", () => {
    expect(baseName("skills/deep/SKILL.md")).toBe("SKILL.md");
    expect(baseName("prompt.md")).toBe("prompt.md");
  });

  it("handles the degenerate shapes without inventing a name", () => {
    expect(baseName("")).toBe("");
    expect(baseName("a/")).toBe("");
    expect(baseName("/leading")).toBe("leading");
  });
});
