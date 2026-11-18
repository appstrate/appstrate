// SPDX-License-Identifier: Apache-2.0

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
  type LucideIcon,
} from "lucide-react";

/** A Lucide file icon for a MIME type (small mapping, neutral `File` fallback). */
function mimeIconFor(mime: string): LucideIcon {
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
 * Render the mime's Lucide icon, the one file glyph of every surface (file pages, chat
 * attachments). `createElement` (not a PascalCase const from the helper) keeps
 * `react-hooks/static-components` happy — the rule flags a component derived from a helper
 * call during render.
 */
export function MimeIcon({ mime, className }: { mime: string; className?: string }) {
  return createElement(mimeIconFor(mime), { className });
}
