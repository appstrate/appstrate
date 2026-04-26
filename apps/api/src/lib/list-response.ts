// SPDX-License-Identifier: Apache-2.0

/**
 * Stripe-canonical list envelope for HTTP list responses.
 *
 * Wire format: `{ object: "list", data: T[], hasMore: boolean, total?: number }`.
 *
 * Every list-shaped HTTP response goes through `listResponse()` so the wire
 * format is enforced at a single call site instead of being repeated inline at
 * each handler. Extra metadata (e.g. `limit` for cursor-style pagination) can
 * be tacked on via spread at the call site without changing the helper.
 */

export interface ListResponse<T> {
  object: "list";
  data: T[];
  hasMore: boolean;
  total?: number;
}

export function listResponse<T>(
  data: T[],
  opts: { hasMore?: boolean; total?: number } = {},
): ListResponse<T> {
  const out: ListResponse<T> = {
    object: "list",
    data,
    hasMore: opts.hasMore ?? false,
  };
  if (opts.total !== undefined) out.total = opts.total;
  return out;
}
