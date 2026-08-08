// SPDX-License-Identifier: Apache-2.0

import { PACKAGE_CONTENT_FILE } from "@appstrate/core/package-files";
import type { PackageType } from "@appstrate/core/validation";

/**
 * A file surfaced in the package UI: the editor's content tab label, the diff
 * sub-tab, and the file the explorer pre-selects for a package type.
 */
export interface DisplayFile {
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

const MANIFEST_FILE = "manifest.json";

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
