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
import { PUBLISHED_FILE_LOG_EVENTS } from "@appstrate/core/file-uri";

/** Minimal shape the helpers read — a structural subset of the `FileDto`. */
export interface FileLike {
  purpose: "user_upload" | "agent_output";
  run_id: string | null;
  packageId: string | null;
  mime: string;
}

/** Which side of the run being viewed a file sits on. */
export type RunFileDirection = "output" | "input";

/**
 * Where a file stands RELATIVE TO the run being viewed: a file that run
 * produced ("output"), or one it consumed ("input"). The single rule every
 * run-scoped surface reads — the tile badge, the Fichiers tab filter, the
 * Outcome list ({@link producedRunFiles}) — so a badge and a filter can never
 * disagree about the same row.
 *
 * Both halves of the predicate are load-bearing, and NEITHER alone is enough.
 * A file row carries two independent facts: `purpose` says who created it,
 * `run_id` says which run it is anchored to.
 *
 * - `purpose` alone is wrong because `GET /api/files?run_id=X` deliberately
 *   answers the run's whole CONTAINER: it ORs `files.run_id = X` with the ids
 *   extracted from `runs.input`, so a file chained in from an earlier run via
 *   `appfile://` is listed here while still carrying `purpose: "agent_output"`
 *   — it was produced by that earlier run, and is an INPUT to this one.
 * - `run_id` alone is wrong because an upload made FOR this run is committed
 *   with `purpose: "user_upload"` AND that run's id (`services/files.ts`), so
 *   matching the id would call the run's own input an output.
 *
 * Ownership is therefore decided by the pair, exactly as `fetchRunFiles()` in
 * `@appstrate/core/run-and-wait-client` decides it server-side; the two rules
 * must not drift.
 */
export function runFileDirection<T extends Pick<FileLike, "purpose" | "run_id">>(
  file: T,
  runId: string,
): RunFileDirection {
  return file.purpose === "agent_output" && file.run_id === runId ? "output" : "input";
}

/**
 * The files a run PRODUCED, out of everything attached to it. A file the run
 * merely consumed as input is not one of them — that distinction is what the
 * Outcome pane is built on, and what separates it from the Fichiers tab, whose
 * job is the complete list.
 *
 * Defined in terms of {@link runFileDirection} so the predicate lives in
 * exactly one place: this list and the per-tile badge answer the same question
 * and must answer it identically.
 */
export function producedRunFiles<T extends Pick<FileLike, "purpose" | "run_id">>(
  files: readonly T[],
  runId: string,
): T[] {
  return files.filter((file) => runFileDirection(file, runId) === "output");
}

/**
 * The derived presentation rule (#1177), shared by the run page and the chat:
 * a run that produced exactly ONE file features it; zero or several feature
 * nothing — several are just listed, and the user picks.
 *
 * Only what THIS run produced counts (see {@link producedRunFiles}). A file the
 * run merely consumed as input never makes a run "single-file" — not even one
 * that an earlier run produced and this one only read — and no agent-declared
 * field takes part: presentation was never the model's call.
 */
export function featuredRunFile<T extends Pick<FileLike, "purpose" | "run_id">>(
  files: readonly T[],
  runId: string,
): T | undefined {
  const produced = producedRunFiles(files, runId);
  return produced.length === 1 ? produced[0] : undefined;
}

/**
 * Does this run-log `event` tag announce a published file? The accepted set
 * (current + pre-#1177 spelling) lives in `@appstrate/core/file-uri`, shared
 * with the chat module's run card: a tag one of them misses is a file list
 * that silently never refreshes, with no error anywhere.
 */
export function isPublishedFileLogEvent(event: string | null | undefined): boolean {
  return !!event && PUBLISHED_FILE_LOG_EVENTS.includes(event);
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
