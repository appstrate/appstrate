// SPDX-License-Identifier: Apache-2.0

/**
 * Run input-document naming.
 *
 * Two distinct concepts per input document:
 *
 *   - **display name** — the document's human name (`documents.name` in the DB,
 *     the name shown to the agent in the prompt). May legitimately collide
 *     across two different input documents (two uploads both called
 *     `report.pdf`).
 *   - **workspace name** — the single filename actually written into the run
 *     container at `workspace/documents/<name>`. Must be UNIQUE within the run,
 *     otherwise one document silently overwrites another when provisioned.
 *
 * {@link assignWorkspaceNames} derives a unique workspace name per entry,
 * deterministically, so the same ordered input always yields the same names
 * (repeated manifest fetches are stable). {@link assertUniqueWorkspaceNames} is
 * the invariant guard that rejects a documents manifest whose workspace names
 * are not unique — the platform never produces one, so it fires only on a
 * malformed / externally-corrupted manifest (400 `duplicate_document_name`).
 *
 * Pure + storage-agnostic: the exact same logic drives FS and S3 provisioning.
 */

import { ApiError } from "../lib/errors.ts";
import { sanitizeStorageKey } from "./file-storage.ts";
import { sanitizeFilename } from "./uploads.ts";

/**
 * 400 raised when two input documents resolve to the same workspace filename.
 * Typed code `duplicate_document_name` so a client can act on it without
 * parsing the human message.
 */
export function duplicateDocumentName(name: string): ApiError {
  return new ApiError({
    status: 400,
    code: "duplicate_document_name",
    title: "Duplicate Document Name",
    detail: `Two input documents resolve to the same workspace filename '${name}'. Rename one so each document has a distinct destination.`,
    param: "input",
  });
}

/**
 * Reduce a display name to a single, safe path segment: strip directory
 * separators + control chars ({@link sanitizeFilename}), fold to an ASCII
 * storage key ({@link sanitizeStorageKey}), and never emit an empty string or a
 * `.`/`..` segment (which the container provisioning guard rejects). This is
 * the segment the collision resolver disambiguates.
 */
export function toWorkspaceSegment(displayName: string): string {
  const seg = sanitizeStorageKey(sanitizeFilename(displayName));
  if (seg === "" || seg === "." || seg === "..") return "file";
  return seg;
}

/**
 * Split a workspace segment into `{ base, ext }` where `ext` includes the dot.
 * The numeric collision suffix is inserted between the two so the extension is
 * preserved (`report.pdf` → `report-2.pdf`). A leading dot (dotfile) or absent
 * dot yields an empty extension (`report` → `report-2`, `.env` → `.env-2`).
 */
function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Assign a unique workspace filename to each entry, preserving input order.
 * Collisions are resolved by inserting a numeric suffix before the extension:
 * `report.pdf`, `report-2.pdf`, `report-3.pdf`. The suffix search skips names
 * already taken (an explicit `report-2.pdf` later in the list is not clobbered),
 * so every returned name is distinct.
 *
 * Pure + deterministic: the output is a function of the ordered `displayNames`
 * list only. The CALLER is responsible for a stable order (collection order —
 * schema property order then array index — which is itself deterministic); given
 * a stable order in, the same names come out every time, so a re-fetched
 * manifest never renames a document.
 */
export function assignWorkspaceNames(displayNames: readonly string[]): string[] {
  const used = new Set<string>();
  return displayNames.map((displayName) => {
    const candidate = toWorkspaceSegment(displayName);
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    const { base, ext } = splitExtension(candidate);
    for (let n = 2; ; n++) {
      const next = `${base}-${n}${ext}`;
      if (!used.has(next)) {
        used.add(next);
        return next;
      }
    }
  });
}

/**
 * Invariant guard for a documents manifest: reject when two entries share a
 * workspace name (identical after sanitization would already have been
 * disambiguated by {@link assignWorkspaceNames}, so a duplicate here means a
 * hand-built or corrupted manifest). Throws {@link duplicateDocumentName} (400).
 */
export function assertUniqueWorkspaceNames(workspaceNames: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of workspaceNames) {
    if (seen.has(name)) throw duplicateDocumentName(name);
    seen.add(name);
  }
}
