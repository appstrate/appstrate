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

/**
 * Stable, unique row identity.
 *
 * NOT the path: `path` is not unique across a tree. An archive holding both a
 * file `docs` and a file `docs/a.md` yields a directory node and a file node
 * that both sit at `docs`, and duplicate entries for one path are possible in a
 * hand-crafted ZIP. Focus, selection, the roving tabindex and the React key all
 * key off `id`, so none of them can address two rows at once.
 */
interface NodeIdentity {
  id: string;
  /** Full path from the artifact root, no trailing slash. */
  path: string;
  /** Last path segment — what the row renders. */
  name: string;
}

export interface DirNode extends NodeIdentity {
  kind: "dir";
  children: TreeNode[];
}

export interface FileNode extends NodeIdentity {
  kind: "file";
  entry: PackageFileEntry;
}

export type TreeNode = DirNode | FileNode;

/**
 * A row of the flattened, windowed-render-ready tree.
 *
 * Carries ONLY what flattening computes. Identity, name and kind are read
 * through `node`, never copied onto the row — a copy is a second source of
 * truth that can silently disagree with the node it came from.
 */
export interface TreeRow {
  node: TreeNode;
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
  // instead of duplicated. Directory paths are therefore unique by
  // construction, which is what makes a path a valid key for the collapsed set.
  const dirs = new Map<string, TreeNode[]>();
  const usedIds = new Set<string>();

  // Ids stay deterministic for a given entry order, so a refetch that returns
  // the same index keeps focus and selection pointing at the same rows.
  const nextId = (kind: TreeNode["kind"], path: string): string => {
    const base = `${kind}:${path}`;
    if (!usedIds.has(base)) {
      usedIds.add(base);
      return base;
    }
    for (let n = 2; ; n++) {
      const candidate = `${base}#${n}`;
      if (!usedIds.has(candidate)) {
        usedIds.add(candidate);
        return candidate;
      }
    }
  };

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
        siblings.push({
          kind: "dir",
          id: nextId("dir", prefix),
          path: prefix,
          name: segment,
          children,
        });
      }
      siblings = children;
    }

    const path = prefix === "" ? fileName : `${prefix}/${fileName}`;
    siblings.push({ kind: "file", id: nextId("file", path), path, name: fileName, entry });
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
 *
 * Takes the COLLAPSED directories, not the expanded ones: everything is open by
 * default, so a directory that appears in a later refetch is expanded by
 * construction instead of being the one closed row in an otherwise open tree.
 *
 * Iterative, not recursive: a path's segment count is attacker-controlled (a
 * crafted ZIP entry name), and one deep enough would overflow the stack and
 * blank the tab for everyone in the org.
 */
export function flattenVisibleRows(
  nodes: readonly TreeNode[],
  collapsedDirs: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  // Pre-order traversal: siblings are pushed in reverse so the stack pops them
  // back in document order.
  const stack: TreeRow[] = [];
  const pushLevel = (siblings: readonly TreeNode[], depth: number) => {
    for (let i = siblings.length - 1; i >= 0; i--) {
      const node = siblings[i]!;
      stack.push({
        node,
        depth,
        expanded: node.kind === "dir" && !collapsedDirs.has(node.path),
        setSize: siblings.length,
        posInSet: i + 1,
      });
    }
  };

  pushLevel(nodes, 0);
  while (stack.length > 0) {
    const row = stack.pop()!;
    rows.push(row);
    if (row.node.kind === "dir" && row.expanded) pushLevel(row.node.children, row.depth + 1);
  }
  return rows;
}

/** What a key press asks the tree to do. `null` = the key changes nothing. */
export type TreeFocusAction = { type: "focus" | "expand" | "collapse"; id: string };

/**
 * The keyboard model, as a reducer over the visible rows (WAI-ARIA tree
 * pattern). Expansion is returned as an intent rather than applied, so the
 * component stays a thin dispatcher and every branch is testable without a DOM.
 *
 * Addresses rows by `node.id`, never by path — two rows can share a path, and
 * keying off it makes ArrowDown/ArrowLeft/Enter act on the wrong one.
 *
 * `null` is returned at the list boundaries and for unhandled keys — the caller
 * uses that to decide whether to `preventDefault()`.
 */
export function nextTreeFocus(
  rows: readonly TreeRow[],
  focusedId: string | null,
  key: string,
): TreeFocusAction | null {
  if (rows.length === 0) return null;
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const index = rows.findIndex((row) => row.node.id === focusedId);

  switch (key) {
    case "Home":
      return { type: "focus", id: first.node.id };
    case "End":
      return { type: "focus", id: last.node.id };
    case "ArrowDown":
      // No focus yet (fresh tree, or the focused row disappeared): enter at the
      // top rather than doing nothing.
      if (index < 0) return { type: "focus", id: first.node.id };
      return index < rows.length - 1 ? { type: "focus", id: rows[index + 1]!.node.id } : null;
    case "ArrowUp":
      if (index < 0) return { type: "focus", id: last.node.id };
      return index > 0 ? { type: "focus", id: rows[index - 1]!.node.id } : null;
    case "ArrowRight": {
      const row = index < 0 ? undefined : rows[index]!;
      if (!row || row.node.kind !== "dir") return null;
      if (!row.expanded) return { type: "expand", id: row.node.id };
      // Already open: descend to the first child, which is the next row.
      const child = rows[index + 1];
      return child && child.depth === row.depth + 1 ? { type: "focus", id: child.node.id } : null;
    }
    case "ArrowLeft": {
      const row = index < 0 ? undefined : rows[index]!;
      if (!row) return null;
      if (row.node.kind === "dir" && row.expanded) return { type: "collapse", id: row.node.id };
      return parentRow(rows, index);
    }
    default:
      return typeAhead(rows, index, key);
  }
}

/** Nearest row above `index` one level shallower — the parent directory. */
function parentRow(rows: readonly TreeRow[], index: number): TreeFocusAction | null {
  const depth = rows[index]!.depth;
  if (depth === 0) return null;
  for (let i = index - 1; i >= 0; i--) {
    if (rows[i]!.depth === depth - 1) return { type: "focus", id: rows[i]!.node.id };
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
    if (row.node.name.toLowerCase().startsWith(needle)) return { type: "focus", id: row.node.id };
  }
  return null;
}

/**
 * The file whose preview is showing: the user's pick while it still exists,
 * else the type's primary file, else the first entry.
 *
 * Derived on every render rather than repaired by an effect — a version switch
 * that drops the selected file falls back silently, and no re-render can
 * clobber a selection the user made.
 */
export function pickActiveEntry(
  entries: readonly PackageFileEntry[],
  selectedPath: string | null,
  primaryFileName: string,
): PackageFileEntry | null {
  return (
    (selectedPath === null ? undefined : entries.find((e) => e.path === selectedPath)) ??
    entries.find((e) => e.path === primaryFileName) ??
    entries[0] ??
    null
  );
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
 * SIZE WINS over the binary verdict, and only above the ceiling. The server
 * never decodes a file larger than `INLINE_MAX_BYTES` — above it,
 * `media_kind` is decided by extension alone (`services/package-files.ts`), so
 * a 1.5 MB `CHANGELOG` or `LICENSE` arrives as `"binary"` while being ordinary
 * text. Telling the user it is binary would be a claim the server never
 * checked; "too large" is true either way and is the constraint that actually
 * blocks the preview. Below the ceiling the classification IS content-based,
 * so a real binary is still reported as one at any size under it.
 */
export function previewBlockReason(entry: PackageFileEntry): PreviewBlockReason | null {
  // Inclusive, mirroring the server's `size <= INLINE_MAX_BYTES`: a file of
  // exactly the ceiling is still inlined, so it must still be previewable.
  if (entry.size > PREVIEW_SIZE_LIMIT) return "too_large";
  if (entry.media_kind === "binary") return "binary";
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
  const base = baseName(path);
  const dot = base.lastIndexOf(".");
  // `dot <= 0` covers both "no extension" and dotfiles like `.gitignore`.
  if (dot <= 0) return "plaintext";
  return LANGUAGE_BY_EXTENSION[base.slice(dot + 1).toLowerCase()] ?? "plaintext";
}

/** Last path segment — the preview header's title and the download filename. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
