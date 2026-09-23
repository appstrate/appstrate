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
 * Three flavours covered here:
 *   - `setCursorLinkHeader` — Stripe-style `startingAfter` / `endingBefore`
 *                             (e.g. `/api/end-users`)
 *   - `setSinceLinkHeader`  — `since` sequence (e.g. `/api/runs/{id}/logs`)
 *   - `setOffsetLinkHeader` — `limit` + `offset` (e.g. `/api/runs`)
 * The two cursor flavours wrap `@appstrate/core/pagination-link` (shared
 * with module routers) and root the link on `APP_URL`.
 *
 * The helpers write directly into the response via `c.header(...)`
 * and silently no-op when there is no next/prev — RFC 5988 allows a
 * partial set of relations.
 */

import type { Context } from "hono";
import {
  setCursorLinkHeader as setCoreCursorLinkHeader,
  setSinceLinkHeader as setCoreSinceLinkHeader,
} from "@appstrate/core/pagination-link";
import { getPublicAppOrigin, toPublicAppUrl } from "./public-url.ts";

type WithoutOrigin<T extends (...args: never[]) => void> = Omit<Parameters<T>[0], "publicOrigin">;

/**
 * Set RFC 5988 `Link` header for cursor-paginated responses (Stripe-style
 * `next` → `?startingAfter=<lastId>`, `prev` → `?endingBefore=<firstId>`),
 * rooted on `APP_URL`. The logic lives in core, shared with module routers.
 */
export function setCursorLinkHeader(args: WithoutOrigin<typeof setCoreCursorLinkHeader>): void {
  setCoreCursorLinkHeader({ ...args, publicOrigin: getPublicAppOrigin() });
}

/**
 * Set RFC 5988 `Link` header for `?since=<id>`-cursor responses (e.g.
 * `/api/runs/{id}/logs`), rooted on `APP_URL`. Other query params (`level`,
 * `limit`, …) are carried forward.
 */
export function setSinceLinkHeader(args: WithoutOrigin<typeof setCoreSinceLinkHeader>): void {
  setCoreSinceLinkHeader({ ...args, publicOrigin: getPublicAppOrigin() });
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
  const url = toPublicAppUrl(c.req.url);
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
