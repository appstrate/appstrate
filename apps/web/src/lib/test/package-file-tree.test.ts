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
import {
  buildFileTree,
  collectDirPaths,
  flattenVisibleRows,
  isPreviewable,
  languageForPath,
  nextTreeFocus,
  previewBlockReason,
  PREVIEW_SIZE_LIMIT,
  type PackageFileEntry,
  type TreeNode,
  type TreeRow,
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

    expect(node).toEqual({ kind: "file", path: "logo.png", name: "logo.png", entry });
  });
});

describe("flattenVisibleRows", () => {
  const tree = buildFileTree([
    file("skills/deep/one.md"),
    file("skills/two.md"),
    file("manifest.json"),
    file("prompt.md"),
  ]);

  it("hides the contents of a collapsed directory", () => {
    const rows = flattenVisibleRows(tree, new Set());

    expect(rows.map((r) => r.path)).toEqual(["skills", "manifest.json", "prompt.md"]);
    expect(rows[0]!.expanded).toBe(false);
    // Files never report themselves as expanded.
    expect(rows[1]!.expanded).toBe(false);
  });

  it("reveals one level per expanded directory", () => {
    const rows = flattenVisibleRows(tree, new Set(["skills"]));

    expect(rows.map((r) => r.path)).toEqual([
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
    const rows = flattenVisibleRows(tree, collectDirPaths(tree));
    const aria = rows.map((r) => [r.path, r.depth, r.setSize, r.posInSet]);

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

  it("collects every directory path, at any depth", () => {
    expect([...collectDirPaths(tree)].sort()).toEqual(["skills", "skills/deep"]);
  });
});

describe("nextTreeFocus", () => {
  // skills/ (expanded) → skills/deep/ (collapsed) → skills/two.md, manifest.json
  const tree = buildFileTree([
    file("skills/deep/one.md"),
    file("skills/two.md"),
    file("manifest.json"),
  ]);
  const rows: TreeRow[] = flattenVisibleRows(tree, new Set(["skills"]));
  const paths = rows.map((r) => r.path);

  it("lays out the fixture as expected", () => {
    expect(paths).toEqual(["skills", "skills/deep", "skills/two.md", "manifest.json"]);
  });

  it("moves down and up one row at a time", () => {
    expect(nextTreeFocus(rows, "skills", "ArrowDown")).toEqual({
      type: "focus",
      path: "skills/deep",
    });
    expect(nextTreeFocus(rows, "skills/two.md", "ArrowUp")).toEqual({
      type: "focus",
      path: "skills/deep",
    });
  });

  it("stops at the list boundaries instead of wrapping", () => {
    expect(nextTreeFocus(rows, "manifest.json", "ArrowDown")).toBeNull();
    expect(nextTreeFocus(rows, "skills", "ArrowUp")).toBeNull();
  });

  it("enters the list when nothing is focused yet", () => {
    expect(nextTreeFocus(rows, null, "ArrowDown")).toEqual({ type: "focus", path: "skills" });
    expect(nextTreeFocus(rows, null, "ArrowUp")).toEqual({ type: "focus", path: "manifest.json" });
    expect(nextTreeFocus(rows, null, "ArrowLeft")).toBeNull();
    expect(nextTreeFocus(rows, null, "ArrowRight")).toBeNull();
  });

  it("jumps to the first and last rows on Home / End", () => {
    expect(nextTreeFocus(rows, "skills/two.md", "Home")).toEqual({ type: "focus", path: "skills" });
    expect(nextTreeFocus(rows, "skills", "End")).toEqual({ type: "focus", path: "manifest.json" });
  });

  it("expands a collapsed directory on ArrowRight, then descends into it", () => {
    expect(nextTreeFocus(rows, "skills/deep", "ArrowRight")).toEqual({
      type: "expand",
      path: "skills/deep",
    });
    // Same row once open: the first child is the next visible row.
    const opened = flattenVisibleRows(tree, new Set(["skills", "skills/deep"]));
    expect(nextTreeFocus(opened, "skills/deep", "ArrowRight")).toEqual({
      type: "focus",
      path: "skills/deep/one.md",
    });
  });

  it("does nothing on ArrowRight over a file", () => {
    expect(nextTreeFocus(rows, "manifest.json", "ArrowRight")).toBeNull();
  });

  it("collapses an open directory on ArrowLeft, then leaves for its parent", () => {
    expect(nextTreeFocus(rows, "skills", "ArrowLeft")).toEqual({
      type: "collapse",
      path: "skills",
    });
    // Collapsed directory / first child: ArrowLeft walks up instead.
    expect(nextTreeFocus(rows, "skills/deep", "ArrowLeft")).toEqual({
      type: "focus",
      path: "skills",
    });
    expect(nextTreeFocus(rows, "skills/two.md", "ArrowLeft")).toEqual({
      type: "focus",
      path: "skills",
    });
  });

  it("has nowhere to go on ArrowLeft from a root-level row", () => {
    expect(nextTreeFocus(rows, "manifest.json", "ArrowLeft")).toBeNull();
  });

  it("type-ahead jumps to the next matching name and wraps around", () => {
    // From `skills`, "m" only matches manifest.json further down.
    expect(nextTreeFocus(rows, "skills", "m")).toEqual({ type: "focus", path: "manifest.json" });
    // From the last row, "s" wraps to the top.
    expect(nextTreeFocus(rows, "manifest.json", "s")).toEqual({ type: "focus", path: "skills" });
    // Case-insensitive, and matches on the base name — not the full path.
    expect(nextTreeFocus(rows, "manifest.json", "D")).toEqual({
      type: "focus",
      path: "skills/deep",
    });
  });

  it("ignores keys it does not model", () => {
    expect(nextTreeFocus(rows, "skills", " ")).toBeNull();
    expect(nextTreeFocus(rows, "skills", "Escape")).toBeNull();
    expect(nextTreeFocus(rows, "skills", "q")).toBeNull();
  });

  it("does nothing at all on an empty tree", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "a"]) {
      expect(nextTreeFocus([], null, key)).toBeNull();
    }
  });
});

/**
 * The preview verdict AND the reason shown to the user. This is the whole of
 * what the preview panel decides — the component renders `previewBlockReason`
 * and holds no rule of its own — so covering it here covers the behaviour a
 * render assertion used to.
 */
describe("previewBlockReason", () => {
  it("clears text below the ceiling, including an empty file", () => {
    expect(previewBlockReason(file("a.md", { size: 0 }))).toBeNull();
    expect(previewBlockReason(file("a.md", { size: 12 }))).toBeNull();
  });

  it("treats the ceiling as inclusive, matching the server's `size <= INLINE_MAX_BYTES`", () => {
    expect(previewBlockReason(file("a.md", { size: PREVIEW_SIZE_LIMIT }))).toBeNull();
    expect(previewBlockReason(file("a.md", { size: PREVIEW_SIZE_LIMIT - 1 }))).toBeNull();
    expect(previewBlockReason(file("a.md", { size: PREVIEW_SIZE_LIMIT + 1 }))).toBe("too_large");
  });

  it("reports binary as binary at any size — shrinking it would not help", () => {
    for (const size of [0, 12, PREVIEW_SIZE_LIMIT, PREVIEW_SIZE_LIMIT + 1, 50_000_000]) {
      expect(previewBlockReason(file("logo.png", { media_kind: "binary", size }))).toBe("binary");
    }
  });

  it("keeps the two reasons distinct — the panel shows a different message for each", () => {
    const binary = previewBlockReason(file("logo.png", { media_kind: "binary", size: 8_192 }));
    const tooLarge = previewBlockReason(file("dump.html", { size: PREVIEW_SIZE_LIMIT + 1 }));
    expect(binary).toBe("binary");
    expect(tooLarge).toBe("too_large");
    expect(binary).not.toBe(tooLarge);
  });

  it("does not depend on `inline` — a dropped budget is still previewable, and bytes past the ceiling are still refused", () => {
    expect(previewBlockReason(file("a.md"))).toBeNull();
    expect(previewBlockReason(file("a.md", { inline: "hello" }))).toBeNull();
    // `inline` above the ceiling is impossible on the wire; the verdict gates
    // on size regardless, so handing the component bytes cannot unblock it.
    expect(
      previewBlockReason(
        file("dump.html", { size: PREVIEW_SIZE_LIMIT + 1, inline: "<script>alert(1)</script>" }),
      ),
    ).toBe("too_large");
  });
});

describe("isPreviewable", () => {
  it("is exactly `previewBlockReason() === null`", () => {
    const cases = [
      file("a.md", { size: 0 }),
      file("a.md", { size: PREVIEW_SIZE_LIMIT }),
      file("a.md", { size: PREVIEW_SIZE_LIMIT + 1 }),
      file("logo.png", { media_kind: "binary" }),
      file("logo.png", { media_kind: "binary", size: PREVIEW_SIZE_LIMIT + 1 }),
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
});
