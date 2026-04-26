// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 5988 `Link` header helpers for paginated list endpoints.
 *
 * Generic SDK pagers traditionally walk the body shape (`hasMore`,
 * `total`, …) which couples them to per-resource envelopes. RFC 5988
 * is the hypermedia escape hatch: emit `Link: <next>; rel="next"` and
 * the consumer follows the URL until the header disappears, no matter
 * what the body shape is.
 *
 * Two flavours covered here:
 *   - `cursorLinkHeader`  — Stripe-style `startingAfter` / `endingBefore`
 *                            (e.g. `/api/end-users`)
 *   - `offsetLinkHeader`  — `limit` + `offset`
 *                            (e.g. `/api/runs`, `/api/notifications`)
 *
 * The helpers write directly into the response via `c.header(...)`
 * and silently no-op when there is no next/prev — RFC 5988 allows a
 * partial set of relations.
 */

import type { Context } from "hono";

interface CursorLinkArgs {
  /** Hono context — the request URL is read from `c.req.url`. */
  c: Context;
  /** True when the current page is followed by another. */
  hasMore: boolean;
  /** ID of the last row on this page; required when `hasMore`. */
  lastId?: string | undefined;
  /** ID of the first row on this page; required when `hasPrev`. */
  firstId?: string | undefined;
  /** Whether a `prev` page exists (caller knows because it received an `endingBefore` query). */
  hasPrev?: boolean;
}

function buildUrl(c: Context, mutate: (params: URLSearchParams) => void): string {
  // `c.req.url` is the full URL — preserve scheme + host + path so the
  // Link href is dereferenceable directly by clients (curl, fetch).
  const url = new URL(c.req.url);
  // Strip cursor query params before adding the new one — `next` and
  // `prev` are mutually exclusive in cursor pagination, and stale
  // values from the inbound URL would break the next round-trip.
  url.searchParams.delete("startingAfter");
  url.searchParams.delete("endingBefore");
  mutate(url.searchParams);
  return url.toString();
}

/**
 * Set RFC 5988 `Link` header for cursor-paginated responses. Mirrors
 * Stripe's pager: `next` → `?startingAfter=<lastId>`, `prev` →
 * `?endingBefore=<firstId>`.
 */
export function setCursorLinkHeader({
  c,
  hasMore,
  lastId,
  firstId,
  hasPrev = false,
}: CursorLinkArgs): void {
  const links: string[] = [];
  if (hasMore && lastId) {
    const next = buildUrl(c, (p) => p.set("startingAfter", lastId));
    links.push(`<${next}>; rel="next"`);
  }
  if (hasPrev && firstId) {
    const prev = buildUrl(c, (p) => p.set("endingBefore", firstId));
    links.push(`<${prev}>; rel="prev"`);
  }
  if (links.length > 0) {
    c.header("Link", links.join(", "));
  }
}

interface OffsetLinkArgs {
  c: Context;
  /** Current page limit. */
  limit: number;
  /** Current page offset (defaults to 0). */
  offset: number;
  /** Total row count, when known. Drives `last` + `prev` clamping. */
  total?: number;
  /** True when another page follows (used when `total` is unknown). */
  hasMore?: boolean;
}

function buildOffsetUrl(c: Context, limit: number, offset: number): string {
  const url = new URL(c.req.url);
  url.searchParams.set("limit", String(limit));
  if (offset > 0) {
    url.searchParams.set("offset", String(offset));
  } else {
    url.searchParams.delete("offset");
  }
  return url.toString();
}

/**
 * Set RFC 5988 `Link` header for offset-paginated responses. Emits
 * `next` + `prev` (and `first` + `last` when `total` is known).
 */
export function setOffsetLinkHeader({ c, limit, offset, total, hasMore }: OffsetLinkArgs): void {
  const links: string[] = [];
  const moreAvailable = hasMore ?? (total !== undefined ? offset + limit < total : false);
  if (moreAvailable) {
    links.push(`<${buildOffsetUrl(c, limit, offset + limit)}>; rel="next"`);
  }
  if (offset > 0) {
    links.push(`<${buildOffsetUrl(c, limit, Math.max(0, offset - limit))}>; rel="prev"`);
    links.push(`<${buildOffsetUrl(c, limit, 0)}>; rel="first"`);
  }
  if (total !== undefined && total > 0) {
    const lastOffset = Math.max(0, Math.floor((total - 1) / limit) * limit);
    if (lastOffset !== offset) {
      links.push(`<${buildOffsetUrl(c, limit, lastOffset)}>; rel="last"`);
    }
  }
  if (links.length > 0) {
    c.header("Link", links.join(", "));
  }
}
