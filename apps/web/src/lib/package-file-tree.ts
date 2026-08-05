// SPDX-License-Identifier: Apache-2.0

/**
 * Pure logic behind the package file explorer.
 *
 * Everything the explorer does that is worth testing lives here rather than in
 * the components: the tree is rendered through a virtualizer, and the web test
 * runner has no DOM, so a rendered tree emits zero rows. Keeping the shape, the
 * ARIA bookkeeping and the keyboard model as pure functions is what makes them
 * coverable at all — and it keeps the React layer to "draw these rows".
 */

import type { components } from "../api/schema";

/** One real file in the artifact, as returned by `GET .../files`. */
export type PackageFileEntry = components["schemas"]["PackageFileEntry"];

/**
 * Largest file the preview will render. Mirrors the API's inline ceiling: past
 * it the server never carries `inline`, and a multi-megabyte blob in Monaco is
 * a browser hazard rather than a preview.
 */
export const PREVIEW_SIZE_LIMIT = 1_048_576;

export interface DirNode {
  kind: "dir";
  /** Full path from the artifact root, no trailing slash. */
  path: string;
  /** Last path segment — what the row renders. */
  name: string;
  children: TreeNode[];
}

export interface FileNode {
  kind: "file";
  path: string;
  name: string;
  entry: PackageFileEntry;
}

export type TreeNode = DirNode | FileNode;

/** A row of the flattened, windowed-render-ready tree. */
export interface TreeRow {
  node: TreeNode;
  path: string;
  name: string;
  kind: TreeNode["kind"];
  /** 0-based nesting depth. `aria-level` is `depth + 1`. */
  depth: number;
  /** Directories only — files are always `false`. */
  expanded: boolean;
  /** Sibling count at this level (`aria-setsize`). */
  setSize: number;
  /** 1-based rank among siblings (`aria-posinset`). */
  posInSet: number;
}

/**
 * Build a nested tree from the flat path index. Directories exist only as path
 * segments in the API response — they are synthesized here, and a directory
 * node therefore never carries an entry of its own.
 *
 * Children are sorted directories-first then by name, independently of the
 * input order: the server sorts by path today, but the rendered order must not
 * silently depend on that.
 */
export function buildFileTree(entries: readonly PackageFileEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  // Directory path → its children array, so a segment seen again is reused
  // instead of duplicated.
  const dirs = new Map<string, TreeNode[]>();

  for (const entry of entries) {
    const segments = entry.path.split("/").filter((s) => s.length > 0);
    const fileName = segments.pop();
    if (fileName === undefined) continue; // defensive: a path of only separators

    let siblings = roots;
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      let children = dirs.get(prefix);
      if (!children) {
        children = [];
        dirs.set(prefix, children);
        siblings.push({ kind: "dir", path: prefix, name: segment, children });
      }
      siblings = children;
    }

    const path = prefix === "" ? fileName : `${prefix}/${fileName}`;
    siblings.push({ kind: "file", path, name: fileName, entry });
  }

  sortChildren(roots);
  for (const children of dirs.values()) sortChildren(children);
  return roots;
}

function sortChildren(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/**
 * Flatten the tree to the rows a virtualizer can window over, carrying the ARIA
 * bookkeeping with them. `aria-setsize` / `aria-posinset` MUST be computed here:
 * only a fraction of the rows is in the DOM at any time, so the browser cannot
 * infer either from the rendered siblings.
 */
export function flattenVisibleRows(
  nodes: readonly TreeNode[],
  expandedDirs: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (siblings: readonly TreeNode[], depth: number) => {
    siblings.forEach((node, index) => {
      const expanded = node.kind === "dir" && expandedDirs.has(node.path);
      rows.push({
        node,
        path: node.path,
        name: node.name,
        kind: node.kind,
        depth,
        expanded,
        setSize: siblings.length,
        posInSet: index + 1,
      });
      if (node.kind === "dir" && expanded) walk(node.children, depth + 1);
    });
  };
  walk(nodes, 0);
  return rows;
}

/** Every directory path in the tree — the default "expand everything" set. */
export function collectDirPaths(
  nodes: readonly TreeNode[],
  acc: Set<string> = new Set(),
): Set<string> {
  for (const node of nodes) {
    if (node.kind === "dir") {
      acc.add(node.path);
      collectDirPaths(node.children, acc);
    }
  }
  return acc;
}

/** What a key press asks the tree to do. `null` = the key changes nothing. */
export type TreeFocusAction =
  | { type: "focus"; path: string }
  | { type: "expand"; path: string }
  | { type: "collapse"; path: string };

/**
 * The keyboard model, as a reducer over the visible rows (WAI-ARIA tree
 * pattern). Expansion is returned as an intent rather than applied, so the
 * component stays a thin dispatcher and every branch is testable without a DOM.
 *
 * `null` is returned at the list boundaries and for unhandled keys — the caller
 * uses that to decide whether to `preventDefault()`.
 */
export function nextTreeFocus(
  rows: readonly TreeRow[],
  focusedPath: string | null,
  key: string,
): TreeFocusAction | null {
  if (rows.length === 0) return null;
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const index = rows.findIndex((row) => row.path === focusedPath);

  switch (key) {
    case "Home":
      return { type: "focus", path: first.path };
    case "End":
      return { type: "focus", path: last.path };
    case "ArrowDown":
      // No focus yet (fresh tree, or the focused row disappeared): enter at the
      // top rather than doing nothing.
      if (index < 0) return { type: "focus", path: first.path };
      return index < rows.length - 1 ? { type: "focus", path: rows[index + 1]!.path } : null;
    case "ArrowUp":
      if (index < 0) return { type: "focus", path: last.path };
      return index > 0 ? { type: "focus", path: rows[index - 1]!.path } : null;
    case "ArrowRight": {
      const row = index < 0 ? undefined : rows[index]!;
      if (!row || row.kind !== "dir") return null;
      if (!row.expanded) return { type: "expand", path: row.path };
      // Already open: descend to the first child, which is the next row.
      const child = rows[index + 1];
      return child && child.depth === row.depth + 1 ? { type: "focus", path: child.path } : null;
    }
    case "ArrowLeft": {
      const row = index < 0 ? undefined : rows[index]!;
      if (!row) return null;
      if (row.kind === "dir" && row.expanded) return { type: "collapse", path: row.path };
      return parentPath(rows, index);
    }
    default:
      return typeAhead(rows, index, key);
  }
}

/** Nearest row above `index` one level shallower — the parent directory. */
function parentPath(rows: readonly TreeRow[], index: number): TreeFocusAction | null {
  const depth = rows[index]!.depth;
  if (depth === 0) return null;
  for (let i = index - 1; i >= 0; i--) {
    if (rows[i]!.depth === depth - 1) return { type: "focus", path: rows[i]!.path };
  }
  return null;
}

/**
 * Single-character type-ahead: jump to the next row whose name starts with the
 * character, wrapping past the end. Space is excluded — it selects.
 */
function typeAhead(rows: readonly TreeRow[], index: number, key: string): TreeFocusAction | null {
  if (key.length !== 1 || key === " ") return null;
  const needle = key.toLowerCase();
  for (let step = 1; step <= rows.length; step++) {
    const row = rows[(index + step + rows.length) % rows.length]!;
    if (row.name.toLowerCase().startsWith(needle)) return { type: "focus", path: row.path };
  }
  return null;
}

/** Why a file cannot be previewed, or `null` when it can. */
export type PreviewBlockReason = "binary" | "too_large";

/**
 * The preview verdict AND its reason, in one place — the panel has to tell the
 * user WHICH limit was hit, and deriving that from `media_kind` again at the
 * render site would put the rule in two places.
 *
 * Deliberately independent of `inline`: an entry can be perfectly previewable
 * and still have been dropped from the response's inline budget, in which case
 * the bytes are fetched on demand.
 *
 * Binary wins over size: a 5 MB image is reported as binary, which is the fact
 * that matters — shrinking it would not make it previewable.
 */
export function previewBlockReason(entry: PackageFileEntry): PreviewBlockReason | null {
  if (entry.media_kind === "binary") return "binary";
  // Inclusive, mirroring the server's `size <= INLINE_MAX_BYTES`: a file of
  // exactly the ceiling is still inlined, so it must still be previewable.
  if (entry.size > PREVIEW_SIZE_LIMIT) return "too_large";
  return null;
}

/** A file is previewable when nothing blocks it. */
export function isPreviewable(entry: PackageFileEntry): boolean {
  return previewBlockReason(entry) === null;
}

/**
 * Extension → Monaco language id. Deliberately a short map of what package
 * artifacts actually contain rather than a mime database; anything unlisted
 * renders as plain text, which is a correct (if plain) preview.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  md: "markdown",
  json: "json",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  sh: "shell",
  yaml: "yaml",
  yml: "yaml",
  css: "css",
  html: "html",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  toml: "ini",
};

export function languageForPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  // `dot <= 0` covers both "no extension" and dotfiles like `.gitignore`.
  if (dot <= 0) return "plaintext";
  return LANGUAGE_BY_EXTENSION[base.slice(dot + 1).toLowerCase()] ?? "plaintext";
}

/** Last path segment — the file name shown in the preview header. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
