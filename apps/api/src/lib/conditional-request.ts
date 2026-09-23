// SPDX-License-Identifier: Apache-2.0

/**
 * Conditional requests (RFC 9110 §13): `If-None-Match` for reads, `If-Match`
 * as the platform's optimistic-concurrency mechanism for writes.
 */

import type { Context } from "hono";
import { inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { ApiError } from "@appstrate/core/api-errors";

interface IfNoneMatchOptions {
  /**
   * Whether `*` counts as a match (default `true`). Pass `false` for a check
   * made before existence is known, or `*` would leak it via a `304`.
   */
  allowWildcard?: boolean;
}

/**
 * True when `header` carries `*` (unless disabled) or a tag matching the
 * quoted `etag` under weak comparison (RFC 9110 §13.1.2).
 */
export function ifNoneMatchSatisfied(
  header: string | undefined,
  etag: string,
  opts?: IfNoneMatchOptions,
): boolean {
  if (!header) return false;
  const allowWildcard = opts?.allowWildcard ?? true;
  const strip = (tag: string) => (tag.startsWith("W/") ? tag.slice(2) : tag);
  const target = strip(etag);
  return header
    .split(",")
    .map((tag) => tag.trim())
    .some((tag) => (tag === "*" ? allowWildcard : strip(tag) === target));
}

/** A resource's version: a monotonic counter, or its `updatedAt`. */
export type ResourceVersion = number | Date | string;

/** The strong entity-tag of one version; timestamps at millisecond precision. */
export function versionEtag(version: ResourceVersion): string {
  const value =
    typeof version === "number" ? String(version) : new Date(version).getTime().toString();
  return `"${value}"`;
}

/** Stamp the response with the resource's `ETag`. */
export function setEtag(c: Context, version: ResourceVersion): void {
  c.header("ETag", versionEtag(version));
}

/**
 * `If-Match` as a predicate on `updatedAt` for the write's own UPDATE, so two
 * writers holding the same ETag cannot both pass. Undefined for no header or
 * `*`; zero rows updated means gone (404) or stale ({@link preconditionFailed}).
 */
export function ifMatchWhere(c: Context, updatedAt: PgColumn): SQL | undefined {
  const header = c.req.header("If-Match");
  if (header === undefined) return undefined;
  const tags = header.split(",").map((tag) => tag.trim());
  if (tags.includes("*")) return undefined;
  const versions = tags.flatMap((tag) => /^"(\d+)"$/.exec(tag)?.[1] ?? []);
  if (versions.length === 0) return sql`false`;
  return inArray(sql`floor(extract(epoch from ${updatedAt}) * 1000)::bigint`, versions);
}

/** The `412` for a write whose `If-Match` no longer names `current`. */
export function preconditionFailed(current: ResourceVersion): ApiError {
  return new ApiError({
    status: 412,
    code: "precondition_failed",
    title: "Precondition Failed",
    detail:
      "The resource changed since you read it: If-Match does not match its current ETag. Re-read it, reapply your change, and send the new ETag.",
    headers: { ETag: versionEtag(current) },
  });
}

/**
 * Evaluate `If-Match` (RFC 9110 §13.1.1, strong comparison) against the
 * version read under the write's lock. Absent header: no-op, or `428` when
 * `required` (RFC 6585 §3).
 */
export function assertIfMatch(
  c: Context,
  current: ResourceVersion,
  opts?: { required?: boolean },
): void {
  const header = c.req.header("If-Match");
  if (header === undefined) {
    if (!opts?.required) return;
    throw new ApiError({
      status: 428,
      code: "precondition_required",
      title: "Precondition Required",
      detail:
        "This write requires an If-Match header carrying the ETag of the representation you read. GET the resource, then send its ETag.",
    });
  }
  const etag = versionEtag(current);
  if (header.split(",").some((tag) => tag.trim() === "*" || tag.trim() === etag)) return;
  throw preconditionFailed(current);
}
