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
  Presentation,
  type LucideIcon,
} from "lucide-react";

/**
 * The MIME an extension stands for, for a file whose MIME is empty or generic (a browser sends
 * `application/octet-stream` for many Office files). A Map: a user-chosen name such as
 * `x.constructor` must not find a key inherited from `Object.prototype`.
 */
const MIME_BY_EXTENSION = new Map([
  ["doc", "application/msword"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["odt", "application/vnd.oasis.opendocument.text"],
  ["xls", "application/vnd.ms-excel"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["ods", "application/vnd.oasis.opendocument.spreadsheet"],
  ["ppt", "application/vnd.ms-powerpoint"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ["odp", "application/vnd.oasis.opendocument.presentation"],
  ["pdf", "application/pdf"],
]);

/** A Lucide file icon for a MIME type (small mapping, neutral `File` fallback); `name` tells the type when the MIME does not. */
function mimeIconFor(mime: string, name?: string | null): LucideIcon {
  let m = mime.toLowerCase();
  if (!m || m === "application/octet-stream") {
    const extension = name?.split(".").pop()?.toLowerCase();
    m = (extension && MIME_BY_EXTENSION.get(extension)) || m;
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
