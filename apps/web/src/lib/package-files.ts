// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "@appstrate/core/validation";

/** A file surfaced in the package UI (content tab label, diff sub-tab). */
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

/**
 * Files surfaced per package type. The first entry is the **primary** file
 * shown in the content tab. A `"content"`-sourced entry also doubles as the
 * **diff companion** (diffed alongside the manifest in the diff tab).
 *
 * Most types follow the shape `manifest + one content file`, where the content
 * file is both the primary display file and the diff companion. `mcp-server`
 * breaks that shape: it has no content file at all — `manifest.json` IS its
 * only required file (AFPS §3.4) — so its primary file is manifest-sourced and
 * it has no diff companion.
 *
 * Non-empty tuple type so `DISPLAY_FILES[type][0]` is known-defined under
 * `noUncheckedIndexedAccess`.
 */
export const DISPLAY_FILES: Record<PackageType, [DisplayFile, ...DisplayFile[]]> = {
  agent: [{ name: "prompt.md", source: "content" }],
  skill: [{ name: "SKILL.md", source: "content" }],
  "mcp-server": [{ name: "manifest.json", source: "manifest" }],
  // INTEGRATION.md is the optional agent-facing doc; the authoritative spec
  // still lives in the manifest (diffed in the manifest sub-tab).
  integration: [{ name: "INTEGRATION.md", source: "content" }],
};

/** Primary file shown in the content tab for a package type. */
export function primaryDisplayFile(type: PackageType): DisplayFile {
  return DISPLAY_FILES[type][0];
}

/**
 * The content-sourced file diffed alongside the manifest, if the type has one.
 * `undefined` for types whose only file is the manifest (e.g. mcp-server).
 */
export function companionDisplayFile(type: PackageType): DisplayFile | undefined {
  return DISPLAY_FILES[type].find((f) => f.source === "content");
}
