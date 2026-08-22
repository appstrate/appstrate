// SPDX-License-Identifier: Apache-2.0

/**
 * Pure, React-free helpers for the files surfaces (run tab + gallery).
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

/** Minimal shape the helpers read — a structural subset of the `FileDto`. */
export interface FileLike {
  purpose: "user_upload" | "agent_output";
  run_id: string | null;
  packageId: string | null;
  mime: string;
}

/**
 * The files a run PRODUCED, out of everything attached to it. A file the run
 * merely consumed as input is not one of them — that distinction is what the
 * Outcome pane is built on, and what separates it from the Fichiers tab, whose
 * job is the complete list.
 */
export function producedRunFiles<T extends Pick<FileLike, "purpose">>(files: readonly T[]): T[] {
  return files.filter((file) => file.purpose === "agent_output");
}

/**
 * The derived presentation rule (#1177), shared by the run page and the chat:
 * a run that produced exactly ONE file features it; zero or several feature
 * nothing — several are just listed, and the user picks.
 *
 * Only what the agent PRODUCED counts (`purpose: "agent_output"`). A file the
 * run merely consumed as input never makes a run "single-file", and no
 * agent-declared field takes part: presentation was never the model's call.
 */
export function featuredRunFile<T extends Pick<FileLike, "purpose">>(
  files: readonly T[],
): T | undefined {
  const produced = producedRunFiles(files);
  return produced.length === 1 ? produced[0] : undefined;
}

/**
 * The run-log `event` tags that mean "a file was published". `"file"` is what
 * the sink writes today; `"document"` is the pre-#1177 spelling and stays
 * readable FOREVER — the run page tails a live stream whose emitter (the API,
 * and behind it a runtime image) deploys independently, and a tag this misses
 * is a file list that silently never refreshes, with no error anywhere.
 */
const PUBLISHED_FILE_LOG_EVENTS: readonly string[] = ["file", "document"];

/** Does this run-log `event` tag announce a published file? */
export function isPublishedFileLogEvent(event: string | null | undefined): boolean {
  return !!event && PUBLISHED_FILE_LOG_EVENTS.includes(event);
}

/**
 * True for an `image/*` mime — the only content shown as a thumbnail (gallery
 * tiles, run-tab tiles, chat attachments). Lives in the shell because the
 * files surfaces are core: an optional module consumes the shell's helpers,
 * never the reverse.
 */
export function isImageMime(mime: string | null | undefined): boolean {
  return !!mime?.startsWith("image/");
}

/**
 * Markdown detection for the preview modal: an explicit `text/markdown` mime
 * (tolerating a `; charset=…` parameter) or a `.md` filename served with a
 * text-ish mime. The preview route relabels markdown as `text/plain` to defeat
 * md→HTML sniffing, so rich rendering has to be decided client-side from the
 * mime/name pair.
 */
export function isMarkdownFile(mime: string, name: string): boolean {
  const m = mime.toLowerCase();
  if (m === "text/markdown" || m.startsWith("text/markdown;")) return true;
  return name.toLowerCase().endsWith(".md") && m.startsWith("text/");
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
 * In-app run-page URL for a file's producing run, or `undefined` when the
 * file has no run container or no package id (e.g. an inline run's ephemeral
 * shadow). `packageId` keeps its `@scope/name` slashes literal to match the
 * Hono route; only the run id is percent-encoded.
 */
export function fileRunHref(file: FileLike): string | undefined {
  if (!file.run_id || !file.packageId) return undefined;
  return `/agents/${file.packageId}/runs/${encodeURIComponent(file.run_id)}`;
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

/**
 * Break a file's `expiresAt` into the parts the expiry badge renders, or
 * `null` when the file is permanent (no deadline) or the timestamp is
 * unparseable. Pure (takes `now`) so the day/hour buckets and the amber
 * threshold are unit-testable without faking the clock.
 */
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
