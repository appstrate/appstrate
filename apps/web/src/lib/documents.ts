// SPDX-License-Identifier: Apache-2.0

/**
 * Pure, React-free helpers for the documents surfaces (run tab + gallery).
 * Kept here (not in a component) so the href and expiry logic is
 * unit-testable in isolation.
 */

import type { Location } from "react-router-dom";

/** Minimal shape the helpers read — a structural subset of the `FileDto`. */
export interface DocumentLike {
  purpose: "user_upload" | "agent_output";
  runId: string | null;
  packageId: string | null;
  mime: string;
}

/**
 * In-app run-page URL for a document's producing run, or `undefined` when the
 * document has no run container or no package id (e.g. an inline run's ephemeral
 * shadow). `packageId` keeps its `@scope/name` slashes literal to match the
 * Hono route; only the run id is percent-encoded.
 */
export function documentRunHref(doc: DocumentLike): string | undefined {
  if (!doc.runId || !doc.packageId) return undefined;
  return `/agents/${doc.packageId}/runs/${encodeURIComponent(doc.runId)}`;
}

/**
 * Addressable preview URL for a table row. Existing filters, unrelated query
 * keys and the hash survive, so opening a document is one reversible location
 * change rather than local UI state.
 */
export function documentPreviewHref(
  location: Pick<Location, "pathname" | "search" | "hash">,
  id: string,
): string {
  const params = new URLSearchParams(location.search);
  params.set("preview", id);
  const search = params.toString();
  return `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
}

/** Documents inside this window (or already past) get the amber "expiring" state. */
const DOCUMENT_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

/** Derived, i18n-free view of a document's retention deadline (see `documentExpiryInfo`). */
export interface DocumentExpiryInfo {
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
 * Break a document's `expiresAt` into the parts the expiry badge renders, or
 * `null` when the document is permanent (no deadline) or the timestamp is
 * unparseable. Pure (takes `now`) so the day/hour buckets and the amber
 * threshold are unit-testable without faking the clock.
 */
export function documentExpiryInfo(
  expiresAt: string | null,
  now: number = Date.now(),
): DocumentExpiryInfo | null {
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
    soon: diffMs <= DOCUMENT_EXPIRY_WARNING_MS,
    expired: diffMs <= 0,
  };
}
