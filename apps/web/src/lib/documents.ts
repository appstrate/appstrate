// SPDX-License-Identifier: Apache-2.0

/**
 * Pure, React-free helpers for the documents surfaces (run tab + gallery).
 * Kept here (not in a component) so the grouping / icon / href logic is
 * unit-testable in isolation.
 */

import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon,
} from "lucide-react";

/** Minimal shape the helpers read — a structural subset of the `DocumentDto`. */
export interface DocumentLike {
  purpose: "user_upload" | "agent_output";
  run_id: string | null;
  packageId: string | null;
  mime: string;
}

/**
 * Pick a Lucide file icon for a MIME type. A small, deterministic mapping
 * (top-level type first, then a few well-known subtypes) with a neutral
 * `File` fallback — no exhaustive registry to rot.
 */
export function mimeIconFor(mime: string): LucideIcon {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return FileImage;
  if (m.startsWith("audio/")) return FileAudio;
  if (m.startsWith("video/")) return FileVideo;
  if (m.startsWith("text/csv") || m.includes("spreadsheet") || m.includes("excel"))
    return FileSpreadsheet;
  if (
    m === "application/zip" ||
    m === "application/gzip" ||
    m === "application/x-tar" ||
    m.includes("compressed")
  )
    return FileArchive;
  if (
    m.startsWith("text/html") ||
    m.includes("json") ||
    m.includes("javascript") ||
    m.includes("xml") ||
    m.startsWith("text/x-") ||
    m.includes("typescript")
  )
    return FileCode;
  if (m.startsWith("text/") || m === "application/pdf") return FileText;
  return FileIcon;
}

/**
 * In-app run-page URL for a document's producing run, or `undefined` when the
 * document has no run container or no package id (e.g. an inline run's ephemeral
 * shadow). `packageId` keeps its `@scope/name` slashes literal to match the
 * Hono route; only the run id is percent-encoded.
 */
export function documentRunHref(doc: DocumentLike): string | undefined {
  if (!doc.run_id || !doc.packageId) return undefined;
  return `/agents/${doc.packageId}/runs/${encodeURIComponent(doc.run_id)}`;
}
