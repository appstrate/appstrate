// SPDX-License-Identifier: Apache-2.0

/**
 * Generic list-query helpers for catalog-style endpoints: offset pagination
 * + a `fields` projection selector. Shared so a heavy in-memory catalog
 * (integrations, the model-provider registry) can be trimmed to what the
 * caller asked for instead of always serializing the full, multi-100KB
 * payload — the failure mode that blew past MCP token caps and forced a
 * file spill.
 *
 * These operate on already-materialized arrays (the catalogs live in memory
 * / are assembled per request), not on SQL — `paginate` slices in process.
 * DB-backed lists keep using the state-layer `{ limit, offset }` queries.
 */

import type { Context } from "hono";
import { invalidRequest } from "./errors.ts";

interface ListPagination {
  limit: number;
  offset: number;
}

/**
 * Parse `limit` / `offset` from the query string. Absent, they are `defaultLimit` and 0. Supplied,
 * `limit` is an integer from 1 to `maxLimit` (default 100) and `offset` a non-negative integer,
 * else a 400 naming the parameter: a page other than the one asked would read as the list.
 */
export function parseListPagination(
  c: Context,
  opts: { defaultLimit: number; maxLimit?: number },
): ListPagination {
  const supplied = (name: "limit" | "offset", min: number, max: number): number | undefined => {
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
  };
  return {
    limit: supplied("limit", 1, opts.maxLimit ?? 100) ?? opts.defaultLimit,
    offset: supplied("offset", 0, Infinity) ?? 0,
  };
}

/** Slice an in-memory array into a page + report `total` / `hasMore`. */
export function paginate<T>(
  items: readonly T[],
  { limit, offset }: ListPagination,
): { page: T[]; total: number; hasMore: boolean } {
  const total = items.length;
  return {
    page: items.slice(offset, offset + limit),
    total,
    hasMore: offset + limit < total,
  };
}

/**
 * Parse a comma-separated `fields` selector against an allowlist.
 *
 * Returns `null` when the param is absent or empty (caller serializes the
 * full shape). Throws a 400 `invalid_request` naming the offending field(s)
 * when any requested field is outside `allowed` — a clear error beats
 * silently ignoring a typo that would otherwise drop a field the caller
 * expected.
 */
export function parseFieldSelection(c: Context, allowed: readonly string[]): Set<string> | null {
  const raw = c.req.query("fields");
  if (raw === undefined) return null;
  const requested = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (requested.length === 0) return null;
  const allowedSet = new Set(allowed);
  const unknown = requested.filter((f) => !allowedSet.has(f));
  if (unknown.length > 0) {
    throw invalidRequest(
      `Unknown field(s) in 'fields': ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}`,
      "fields",
    );
  }
  return new Set(requested);
}

/**
 * Project an object down to the selected `fields`. `null` fields returns the
 * item untouched. `always` keys (a stable identity column like `id` /
 * `providerId`) are kept regardless so every projected row stays addressable.
 */
export function projectFields<T extends object>(
  item: T,
  fields: Set<string> | null,
  always: readonly string[] = [],
): Partial<T> {
  if (fields === null) return item;
  const out: Partial<T> = {};
  for (const key of Object.keys(item) as (keyof T)[]) {
    if (fields.has(key as string) || always.includes(key as string)) {
      out[key] = item[key];
    }
  }
  return out;
}
