// SPDX-License-Identifier: Apache-2.0

/**
 * List-endpoint building blocks shared by the platform and its modules: the
 * `limit` / `offset` query parsers (a 400 naming the parameter, never a silent
 * fallback) and the Stripe-canonical list envelope. They live in core because a
 * module cannot import from the platform's source tree.
 */

import type { Context } from "hono";
import { invalidRequest } from "./api-errors.ts";

export interface ListPagination {
  limit: number;
  offset: number;
}

/** Wire shape of every list response: `{ object: "list", data, hasMore, total? }`. */
export interface ListEnvelope<T> {
  object: "list";
  data: T[];
  hasMore: boolean;
  total?: number;
  limit?: number;
}

function suppliedInteger(
  c: Context,
  name: "limit" | "offset",
  min: number,
  max: number,
): number | undefined {
  const raw = c.req.query(name);
  if (raw === undefined) return undefined;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (value >= min && value <= max) return value;
  throw invalidRequest(
    max === Infinity
      ? `${name} must be an integer of at least ${min}`
      : `${name} must be an integer from ${min} to ${max}`,
    name,
  );
}

/**
 * Parse `limit` alone, for keyset-paginated lists that take no `offset`. Absent, it is
 * `defaultLimit`. Supplied, it is an integer from 1 to `maxLimit` (default 100), else a 400
 * naming the parameter: a page other than the one asked would read as the list.
 */
export function parseListLimit(
  c: Context,
  opts: { defaultLimit: number; maxLimit?: number },
): number {
  return suppliedInteger(c, "limit", 1, opts.maxLimit ?? 100) ?? opts.defaultLimit;
}

/** `parseListLimit` plus `offset` (a non-negative integer, default 0) for offset-paginated lists. */
export function parseListPagination(
  c: Context,
  opts: { defaultLimit: number; maxLimit?: number },
): ListPagination {
  return {
    limit: parseListLimit(c, opts),
    offset: suppliedInteger(c, "offset", 0, Infinity) ?? 0,
  };
}

/** Build the list envelope; extra metadata (e.g. `limit`) is spread by the caller. */
export function listResponse<T>(
  data: T[],
  opts: { hasMore?: boolean; total?: number } = {},
): ListEnvelope<T> {
  const out: ListEnvelope<T> = {
    object: "list",
    data,
    hasMore: opts.hasMore ?? false,
  };
  if (opts.total !== undefined) out.total = opts.total;
  return out;
}
