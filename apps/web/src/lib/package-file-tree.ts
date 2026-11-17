// SPDX-License-Identifier: Apache-2.0

/** Pure logic of the package file explorer: the web test runner has no DOM, so shape, ARIA and keyboard model live here to be testable. */

import {
  PACKAGE_FILE_INLINE_MAX_BYTES,
  PACKAGE_MANIFEST_FILE,
} from "@appstrate/core/package-files";
import {
  isProtectedPackageFile,
  applyFileTreeOperations,
  PackageFileWriteError,
} from "@appstrate/core/package-file-operations";
import { isSafeArchivePath } from "@appstrate/core/zip";
import type { PackageType } from "@appstrate/core/validation";
import type { components } from "../api/schema";

/** One real file in the artifact, as returned by `GET .../files`. */
export type PackageFileEntry = components["schemas"]["PackageFileEntry"];

/** One staged file edit carried by the package PATCH's `operations` field. */
export type PackageFileWriteOperation = components["schemas"]["PackageFileWriteOperation"];

/** Stable row identity. NOT the path: a file `docs` and `docs/a.md` put a dir and a file node at `docs`, and a crafted ZIP can repeat a path. */
interface NodeIdentity {
  id: string;
  /** Full path from the artifact root, no trailing slash. */
  path: string;
  /** Last path segment — what the row renders. */
  name: string;
}

interface DirNode extends NodeIdentity {
  kind: "dir";
  children: TreeNode[];
}

interface FileNode extends NodeIdentity {
  kind: "file";
  entry: PackageFileEntry;
}

export type TreeNode = DirNode | FileNode;

/** A flattened row; carries ONLY what flattening computes (identity, name, kind are read via `node`, never copied). */
interface TreeRow {
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

/** Builds the nested tree from the flat index; directories are synthesized (no entry of their own), sorted dirs-first then by name regardless of input order. */
export function buildFileTree(entries: readonly PackageFileEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  // Directory path → children, reused on a repeated segment: dir paths are unique, so valid keys for the collapsed set.
  const dirs = new Map<string, TreeNode[]>();
  const usedIds = new Set<string>();

  // Deterministic ids: a refetch of the same index keeps focus and selection on the same rows.
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

  const ensureDirectory = (directoryPath: string) => {
    const segments = directoryPath.split("/").filter((segment) => segment.length > 0);
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
  };

  for (const entry of entries) {
    const segments = entry.path.split("/").filter((s) => s.length > 0);
    const fileName = segments.pop();
    if (fileName === undefined) continue; // defensive: a path of only separators

    const directoryPath = segments.join("/");
    ensureDirectory(directoryPath);
    const siblings = directoryPath === "" ? roots : dirs.get(directoryPath)!;
    const prefix = directoryPath;

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
 * Flattens the tree into its visible rows, with the `aria-setsize` / `aria-posinset` of each. Takes
 * the COLLAPSED directories so a new directory is open by default. Iterative, not recursive: path depth is attacker-controlled (crafted
 * ZIP entry name) and would overflow the stack.
 */
export function flattenVisibleRows(
  nodes: readonly TreeNode[],
  collapsedDirs: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  // Pre-order: siblings pushed in reverse so the stack pops them in document order.
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
type TreeFocusAction = { type: "focus" | "expand" | "collapse"; id: string };

/**
 * The WAI-ARIA tree keyboard model as a reducer over visible rows; expansion is returned as an
 * intent. Addresses rows by `node.id` (two rows can share a path). `null` at list boundaries and
 * for unhandled keys tells the caller not to `preventDefault()`.
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
      // No focus yet (fresh tree, or the focused row vanished): enter at the top.
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

/** Single-character type-ahead to the next row starting with it, wrapping; space is excluded (it selects). */
function typeAhead(rows: readonly TreeRow[], index: number, key: string): TreeFocusAction | null {
  if (key.length !== 1 || key === " ") return null;
  const needle = key.toLowerCase();
  for (let step = 1; step <= rows.length; step++) {
    const row = rows[(index + step + rows.length) % rows.length]!;
    if (row.node.name.toLowerCase().startsWith(needle)) return { type: "focus", id: row.node.id };
  }
  return null;
}

/** The previewed file: the user's pick while it exists, else the type's primary file, else the first. Derived per render, not repaired by an effect. */
export function pickActiveEntry<T extends PackageFileEntry>(
  entries: readonly T[],
  selectedPath: string | null,
  primaryFileName: string,
): T | null {
  return (
    (selectedPath === null ? undefined : entries.find((e) => e.path === selectedPath)) ??
    entries.find((e) => e.path === primaryFileName) ??
    entries[0] ??
    null
  );
}

/** Why a file cannot be previewed, or `null` when it can. */
type PreviewBlockReason = "binary" | "too_large";

/**
 * The preview verdict AND its reason (the panel must say WHICH limit was hit). Independent of
 * `inline`: bytes dropped from the inline budget are fetched on demand.
 *
 * SIZE WINS over the binary verdict, above the ceiling only: the server never decodes a file larger
 * than `PACKAGE_FILE_INLINE_MAX_BYTES` and sets `media_kind` by extension alone
 * (`services/package-files.ts`), so a 1.5 MB `CHANGELOG` arrives as `"binary"`; "too large" is the
 * claim that is true either way. Below the ceiling classification is content-based.
 */
export function previewBlockReason(entry: PackageFileEntry): PreviewBlockReason | null {
  // Inclusive, mirroring the server's `size <= PACKAGE_FILE_INLINE_MAX_BYTES`.
  if (entry.size > PACKAGE_FILE_INLINE_MAX_BYTES) return "too_large";
  if (entry.media_kind === "binary") return "binary";
  return null;
}

/** Extension → Monaco language id; a short map on purpose, unlisted renders as plain text. */
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

/**
 * Whether the draft write route refuses to move or delete the entry (`applyFileOperations`):
 * `manifest.json` (a projection of the draft manifest; `reserved_entry`) and the type's content
 * entry (`SKILL.md`, `prompt.md`; `content_entry_immovable`, still WRITABLE).
 */
export function isPinnedEntry(type: PackageType, path: string): boolean {
  return isProtectedPackageFile(type, path);
}

/**
 * Why a typed path cannot be created, or `null`. Restates the write route's refusals so the dialog
 * answers before a round trip; the server stays the authority (same rules under the lock).
 *
 * - `invalid` — {@link isSafeArchivePath} refuses the shape (`invalid_path`).
 * - `reserved` — it names the manifest (`reserved_entry`).
 * - `exists` — a `write` would silently overwrite, which "new file" and "rename" must not do.
 * - `conflict` — one path both file and directory, either direction (`path_conflict`).
 */
type NewPathRejection = "invalid" | "reserved" | "exists" | "conflict";

export const NEW_PATH_ERROR_KEYS: Record<NewPathRejection, string> = {
  invalid: "files.errorInvalidPath",
  reserved: "files.errorReserved",
  exists: "files.errorExists",
  conflict: "files.errorConflictPath",
};

export function validateNewPath(
  entries: readonly PackageFileEntry[],
  path: string,
): NewPathRejection | null {
  if (!isSafeArchivePath(path)) return "invalid";
  if (path === PACKAGE_MANIFEST_FILE) return "reserved";

  if (entries.some((entry) => entry.path === path)) return "exists";
  try {
    applyFileTreeOperations(
      Object.fromEntries(entries.map((entry) => [entry.path, entry])),
      [{ op: "write", path, value: { path, size: 0, media_kind: "text" } }],
      "skill",
    );
  } catch (error) {
    if (error instanceof PackageFileWriteError) {
      if (error.code === "invalid_path") return "invalid";
      if (error.code === "reserved_entry") return "reserved";
      if (error.code === "path_conflict") return "conflict";
    }
    throw error;
  }

  return null;
}

/** The structural action a key press asks of the focused file row, or `null`. */
export function fileActionForKey(key: string): "rename" | "delete" | null {
  if (key === "F2") return "rename";
  if (key === "Delete") return "delete";
  return null;
}

/** Last path segment — the preview header's title and the download filename. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
