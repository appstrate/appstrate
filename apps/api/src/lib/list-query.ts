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
import { z } from "zod";
import { invalidRequest } from "./errors.ts";

interface ListPagination {
  limit: number;
  offset: number;
}

/**
 * Parse `limit` / `offset` from the query string. A `limit` above `maxLimit` (default 100) is a
 * 400 on `limit`: serving fewer rows than asked would read as the whole list. Any other value that
 * is not a positive integer, and a negative or non-numeric `offset`, fall back to the defaults.
 */
export function parseListPagination(
  c: Context,
  opts: { defaultLimit: number; maxLimit?: number },
): ListPagination {
  const maxLimit = opts.maxLimit ?? 100;
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .catch(opts.defaultLimit)
    .parse(c.req.query("limit") ?? opts.defaultLimit);
  if (limit > maxLimit) throw invalidRequest(`limit must be at most ${maxLimit}`, "limit");
  const offset = z.coerce
    .number()
    .int()
    .min(0)
    .catch(0)
    .parse(c.req.query("offset") ?? 0);
  return { limit, offset };
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
