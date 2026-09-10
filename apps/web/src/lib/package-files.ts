// SPDX-License-Identifier: Apache-2.0

import { PACKAGE_CONTENT_FILE } from "@appstrate/core/package-files";
import type { PackageType } from "@appstrate/core/validation";
import { ApiError } from "../api/errors";

/**
 * A file surfaced in the package UI: the editor's content tab label, the diff
 * sub-tab, and the file the explorer pre-selects for a package type.
 */
interface DisplayFile {
  /** File name, shown verbatim as a tab label (filenames are not translated). */
  name: string;
  /**
   * Where the displayed bytes come from:
   * - `"content"`: the package's stored content file (e.g. prompt.md, SKILL.md)
   * - `"manifest"`: serialized from the manifest object — the type has no
   *   separate content file, the manifest IS the displayed payload.
   */
  source: "manifest" | "content";
}

/**
 * The archive entry that carries a package's manifest.
 *
 * Exported because it is not only a display name: the draft file editor refuses
 * to write, rename or delete it (the write route answers `reserved_entry`), so
 * the tree and the path validator both have to recognize it.
 */
export const MANIFEST_FILE = "manifest.json";

/**
 * Primary file of a package type — the editor's content tab, and the entry the
 * file explorer opens on when the artifact carries it.
 *
 * Derived from `PACKAGE_CONTENT_FILE` rather than restated: which file a type's
 * content lives in is one AFPS fact, and it is the fact the ZIP parser and the
 * draft overlay already read from that map. A local copy here is how the four
 * declarations that preceded it drifted apart.
 *
 * Most types follow the shape `manifest + one content file`. `mcp-server`
 * breaks it: it has no content file at all — `manifest.json` IS its only
 * required file (AFPS §3.4) — which the map records as `null`.
 */
export function primaryDisplayFile(type: PackageType): DisplayFile {
  const content = PACKAGE_CONTENT_FILE[type];
  return content === null
    ? { name: MANIFEST_FILE, source: "manifest" }
    : { name: content, source: "content" };
}

/**
 * The content-sourced file diffed alongside the manifest, if the type has one.
 * `undefined` for types whose only file is the manifest (e.g. mcp-server) —
 * there is nothing to diff beside it.
 */
export function companionDisplayFile(type: PackageType): DisplayFile | undefined {
  const primary = primaryDisplayFile(type);
  return primary.source === "content" ? primary : undefined;
}

/**
 * The message an author reads when a draft-tree write is refused, keyed by the
 * route's machine-readable `code` rather than by its status or its English
 * `detail` — or `null` for a failure this surface does not own.
 *
 * `null` is the load-bearing half: the same save button sends the file batch
 * AND the manifest, so the editor's error banner asks both translators. A
 * blanket "saving the files failed" here would swallow the manifest's own
 * messages, which are the specific ones.
 *
 * Only the refusals the editor can actually provoke are named. The two it
 * cannot — `content_entry_immovable` and `not_found` — are deliberately absent:
 * the tree offers no rename or delete on a pinned entry, and every path it
 * sends comes from the index it is showing, so either one means the client's
 * picture of the package is wrong in a way no specific sentence would help
 * with.
 */
export function packageFilesErrorKey(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    // The tree moved under this editor: the fix is to re-read it, and the
    // buffered edits are kept so the author can save them again.
    case "precondition_failed":
      return "files.errorConflict";
    case "invalid_path":
      return "files.errorInvalidPath";
    case "reserved_entry":
      return "files.errorReserved";
    case "path_conflict":
      return "files.errorConflictPath";
    case "file_too_large":
    case "tree_too_large":
      return "files.errorTooLarge";
    default:
      return null;
  }
}
