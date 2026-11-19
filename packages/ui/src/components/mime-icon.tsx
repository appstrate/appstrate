// SPDX-License-Identifier: Apache-2.0

import { normalizeMime } from "@appstrate/core/mime";
import { createElement } from "react";
import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  type LucideIcon,
} from "lucide-react";

/** Use the filename only when no specific MIME is available. */
const ICON_BY_EXTENSION = new Map<string, LucideIcon>([
  ["doc", FileText],
  ["docx", FileText],
  ["odt", FileText],
  ["pdf", FileText],
  ["xls", FileSpreadsheet],
  ["xlsx", FileSpreadsheet],
  ["ods", FileSpreadsheet],
  ["ppt", Presentation],
  ["pptx", Presentation],
  ["odp", Presentation],
]);

function mimeIconFor(mime: string, name?: string | null): LucideIcon {
  const m = normalizeMime(mime);
  if (!m || m === "application/octet-stream") {
    const extension = name?.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
    return (extension && ICON_BY_EXTENSION.get(extension)) || FileIcon;
  }
  if (m.startsWith("image/")) return FileImage;
  if (m.startsWith("audio/")) return FileAudio;
  if (m.startsWith("video/")) return FileVideo;
  if (m.startsWith("text/csv") || m.includes("spreadsheet") || m.includes("excel"))
    return FileSpreadsheet;
  // Before the code family below: `openxmlformats` contains "xml".
  if (m.includes("presentation") || m.includes("powerpoint")) return Presentation;
  if (m.includes("wordprocessing") || m === "application/msword" || m.includes("opendocument.text"))
    return FileText;
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
 * Render the mime's Lucide icon, the one file glyph of every surface (file pages, chat
 * attachments). `createElement` (not a PascalCase const from the helper) keeps
 * `react-hooks/static-components` happy — the rule flags a component derived from a helper
 * call during render.
 */
export function MimeIcon({
  mime,
  name,
  className,
}: {
  mime: string;
  /** The file's name, when known: its extension tells the type when `mime` is empty or generic. */
  name?: string | null;
  className?: string;
}) {
  return createElement(mimeIconFor(mime, name), { className });
}
