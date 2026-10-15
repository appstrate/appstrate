// SPDX-License-Identifier: Apache-2.0

/** Pure, React-free helpers for the files surfaces (run page, Fichiers page). */

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
import { isFileProducedByRun, PUBLISHED_FILE_LOG_EVENT } from "@appstrate/core/file-uri";
import { runDetailPath } from "./package-paths";

/** Minimal shape the helpers read — a structural subset of the `FileDto`. */
export interface FileLike {
  purpose: "user_upload" | "agent_output";
  runId: string | null;
  packageId: string | null;
  mime: string;
}

/** Which side of the run being viewed a file sits on. */
export type RunFileDirection = "output" | "input";

/** Whether a file was produced ("output") or consumed ("input") by the run being viewed; the single rule for badges and lists. Ownership itself is `isFileProducedByRun` (`@appstrate/core/file-uri`). */
export function runFileDirection<T extends Pick<FileLike, "purpose" | "runId">>(
  file: T,
  runId: string,
): RunFileDirection {
  return isFileProducedByRun(file, runId) ? "output" : "input";
}

/** The files a run PRODUCED (not merely consumed); the Outcome pane's basis, unlike the Fichiers tab's complete list. Built on {@link runFileDirection}. */
export function producedRunFiles<T extends Pick<FileLike, "purpose" | "runId">>(
  files: readonly T[],
  runId: string,
): T[] {
  return files.filter((file) => runFileDirection(file, runId) === "output");
}

/** Presentation rule shared by the run page and chat: a run that produced exactly ONE file features it (see {@link producedRunFiles}); no agent-declared field takes part. */
export function featuredRunFile<T extends Pick<FileLike, "purpose" | "runId">>(
  files: readonly T[],
  runId: string,
): T | undefined {
  const produced = producedRunFiles(files, runId);
  return produced.length === 1 ? produced[0] : undefined;
}

/** Whether a run-log `event` tag announces a published file; the one tag (`@appstrate/core/file-uri`) is shared with the chat run card, and a miss means a list that silently never refreshes. */
export function isPublishedFileLogEvent(event: string | null | undefined): boolean {
  return event === PUBLISHED_FILE_LOG_EVENT;
}

/** Markdown detection: the preview route relabels markdown as `text/plain` (against md→HTML sniffing), so it is decided client-side from the mime/name pair. */
export function isMarkdownFile(mime: string, name: string): boolean {
  const m = mime.toLowerCase();
  if (m === "text/markdown" || m.startsWith("text/markdown;")) return true;
  return name.toLowerCase().endsWith(".md") && m.startsWith("text/");
}

/** A Lucide file icon for a MIME type (small mapping, neutral `File` fallback). */
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

/** Run-page URL for a file's producing run; `undefined` without a run container or package id (e.g. an inline run's ephemeral shadow). */
export function fileRunHref(file: FileLike): string | undefined {
  if (!file.runId || !file.packageId) return undefined;
  return runDetailPath(file.packageId, file.runId);
}

/** Files inside this window (or already past) get the amber "expiring" state. */
const FILE_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

/** Derived, i18n-free view of a file's retention deadline (see `fileExpiryInfo`). */
interface FileExpiryInfo {
  /** Whole days remaining until expiry (floored, never negative). */
  days: number;
  /** Whole hours remaining when under a day (floored, never negative). */
  hours: number;
  /** Within the 7-day warning window, or already past — the amber state. */
  soon: boolean;
  /** Deadline already reached (bytes pending GC). */
  expired: boolean;
}

/** Splits `expiresAt` into the expiry badge's parts; `null` when permanent or unparseable. Takes `now` for testability. */
export function fileExpiryInfo(
  expiresAt: string | null,
  now: number = Date.now(),
): FileExpiryInfo | null {
  if (!expiresAt) return null;
  const ts = new Date(expiresAt).getTime();
  if (Number.isNaN(ts)) return null;
  const diffMs = ts - now;
  const totalHours = Math.max(0, Math.floor(diffMs / (60 * 60 * 1000)));
  return {
    days: Math.floor(totalHours / 24),
    // A still-valid sub-hour deadline reads "1h", never the odd "0h" (the
    // truly-past case is labelled via `expired`, not the hour count).
    hours: diffMs > 0 ? Math.max(1, totalHours % 24) : 0,
    soon: diffMs <= FILE_EXPIRY_WARNING_MS,
    expired: diffMs <= 0,
  };
}

/** The `type.<kind>` locale suffix a file's mime reads as. */
export function mimeKind(mime: string): string {
  const normalized = mime.split(";", 1)[0]?.toLowerCase() ?? mime.toLowerCase();
  if (normalized === "application/pdf") return "pdf";
  if (normalized === "text/csv") return "csv";
  if (normalized.includes("json")) return "json";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("text/")) return "text";
  if (
    normalized.includes("zip") ||
    normalized.includes("gzip") ||
    normalized.includes("tar") ||
    normalized.includes("compressed")
  )
    return "archive";
  if (normalized.includes("spreadsheet") || normalized.includes("excel")) return "spreadsheet";
  return "file";
}
