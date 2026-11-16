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
 */

import type { Context } from "hono";
import type { ListPagination } from "@appstrate/core/list-query";
import { invalidRequest } from "./errors.ts";

/**
 * The query of a list that reads none: any parameter is a 400 naming it, so a
 * misspelled filter never reads as a list that was narrowed.
 */
export function parseEmptyQuery(c: Context): void {
  const [name] = Object.keys(c.req.queries());
  if (name !== undefined) throw invalidRequest(`Unknown query parameter '${name}'`, name);
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
