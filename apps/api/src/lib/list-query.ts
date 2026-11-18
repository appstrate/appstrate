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
import { z } from "zod";
import { zFilePurposeEnum } from "@appstrate/db/schema";
import { parseListPagination, type ListPagination } from "@appstrate/core/list-query";
import { scopedNameRegex } from "@appstrate/core/validation";
import type { AppEnv } from "../types/index.ts";
import type { ListFilesFilters } from "../services/files.ts";
import { invalidRequest, parseBody, zodIssuesToFieldErrors } from "./errors.ts";

/**
 * The query of a list that reads none: any parameter is a 400 naming it, so a
 * misspelled filter never reads as a list that was narrowed.
 */
export function parseEmptyQuery(c: Context): void {
  const [name] = Object.keys(c.req.queries());
  if (name !== undefined) throw invalidRequest(`Unknown query parameter '${name}'`, name);
}

/**
 * The query of a list read through `schema` (a `.strict()` object): an unknown
 * parameter or an invalid value is one 400 naming the parameter.
 */
export function parseStrictQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    const [issue] = zodIssuesToFieldErrors(parsed.error.issues);
    throw invalidRequest(issue!.message, issue!.field);
  }
  return parsed.data;
}

/**
 * A closed-set filter. An unrecognised value is a 400: dropping it would widen
 * a list the caller reads as narrowed. An empty value (`?kind=`) reads as
 * absent — how a form or a URL builder emitting every key spells "no filter".
 */
export const closedSet = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), z.enum(values).optional());

/**
 * The `packageId` filter of a list (runs, schedules): one package id. An empty
 * value reads as absent, as on the closed sets.
 */
export const packageIdFilter = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .regex(scopedNameRegex, { error: "packageId must be a package id (@scope/name)" })
    .optional(),
);

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

const listFilesQuerySchema = z
  .object({
    purpose: zFilePurposeEnum.optional(),
    runId: z.string().optional(),
    packageId: z.string().optional(),
    chat_session_id: z.string().optional(),
    context_chat_session_id: z.string().optional(),
    q: z.string().max(200).trim().optional(),
    startingAfter: z.string().optional(),
    // Checked by `parseListPagination` (anything but 1..100 is a 400).
    limit: z.string().optional(),
  })
  .strict();

/**
 * The gallery filters of `GET /api/files` and `GET /api/orgs/{orgId}/files`.
 * Query-param casing follows the wire DTO (CASING_CONVENTIONS.md carve-out 4b):
 * `runId`, `packageId` and the `startingAfter` pagination param are camelCase;
 * `chat_session_id` is a snake_case domain field. Strict: an unknown or
 * misspelled filter is a 400, never a silently widened listing.
 */
export function parseListFilesQuery(c: Context<AppEnv>): ListFilesFilters {
  const parsed = parseBody(listFilesQuerySchema, c.req.query());
  const filters: ListFilesFilters = {};
  if (parsed.purpose) filters.purpose = parsed.purpose;
  if (parsed.runId) filters.runId = parsed.runId;
  if (parsed.packageId) filters.packageId = parsed.packageId;
  if (parsed.chat_session_id) filters.chatSessionId = parsed.chat_session_id;
  if (parsed.context_chat_session_id) {
    filters.contextChatSessionId = parsed.context_chat_session_id;
  }
  if (parsed.q) filters.search = parsed.q;
  if (parsed.startingAfter) filters.startingAfter = parsed.startingAfter;
  filters.limit = parseListPagination(c, { defaultLimit: 20 }).limit;
  return filters;
}
