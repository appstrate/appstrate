// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 8288 `Link` headers for cursor-paginated lists, shared by core and module
 * routers. URLs are re-rooted on the public origin so they stay dereferenceable
 * behind a reverse proxy.
 */

import type { Context } from "hono";

interface LinkBase {
  c: Context;
  /** Public origin every emitted URL is rooted on. */
  publicOrigin: string;
  hasMore: boolean;
}

function linkUrl(c: Context, publicOrigin: string, param: string, cursor: string | number): string {
  const source = new URL(c.req.url);
  const url = new URL(`${source.pathname}${source.search}`, publicOrigin);
  // Cursor params are mutually exclusive: a stale inbound one would break the next hop.
  url.searchParams.delete("startingAfter");
  url.searchParams.delete("endingBefore");
  url.searchParams.set(param, String(cursor));
  return url.toString();
}

/**
 * Stripe-style keyset: `next` → `?startingAfter=<lastId>`, `prev` →
 * `?endingBefore=<firstId>` (when the caller knows a previous page exists).
 */
export function setCursorLinkHeader({
  c,
  publicOrigin,
  hasMore,
  lastId,
  firstId,
  hasPrev = false,
}: LinkBase & {
  /** Id of the last row on this page; required when `hasMore`. */
  lastId?: string | undefined;
  /** Id of the first row on this page; required when `hasPrev`. */
  firstId?: string | undefined;
  hasPrev?: boolean;
}): void {
  const links: string[] = [];
  if (hasMore && lastId) {
    links.push(`<${linkUrl(c, publicOrigin, "startingAfter", lastId)}>; rel="next"`);
  }
  if (hasPrev && firstId) {
    links.push(`<${linkUrl(c, publicOrigin, "endingBefore", firstId)}>; rel="prev"`);
  }
  if (links.length > 0) c.header("Link", links.join(", "));
}

/** Append-only sequence: `next` → `?since=<lastId>` (the polling-tail cursor). */
export function setSinceLinkHeader({
  c,
  publicOrigin,
  hasMore,
  lastId,
}: LinkBase & {
  /** Monotonic cursor of the last row on this page; required when `hasMore`. */
  lastId?: number | undefined;
}): void {
  if (!hasMore || lastId === undefined) return;
  c.header("Link", `<${linkUrl(c, publicOrigin, "since", lastId)}>; rel="next"`);
}
