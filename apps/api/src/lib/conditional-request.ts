// SPDX-License-Identifier: Apache-2.0

/**
 * Conditional requests (RFC 9110 §13): `If-None-Match` for reads, `If-Match`
 * for the optimistic concurrency of package draft writes.
 */

import type { Context } from "hono";
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

/** The strong entity-tag of a draft's `lock_version`. */
function versionEtag(version: number): string {
  return `"${version}"`;
}

/** Stamp the response with the draft's `ETag`. */
export function setEtag(c: Context, version: number): void {
  c.header("ETag", versionEtag(version));
}

/**
 * Evaluate `If-Match` (RFC 9110 §13.1.1, strong comparison) against the
 * version read under the write's lock. Absent header: no-op, or `428` when
 * `required` (RFC 6585 §3).
 */
export function assertIfMatch(c: Context, current: number, opts?: { required?: boolean }): void {
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
  throw new ApiError({
    status: 412,
    code: "precondition_failed",
    title: "Precondition Failed",
    detail:
      "The resource changed since you read it: If-Match does not match its current ETag. Re-read it, reapply your change, and send the new ETag.",
    headers: { ETag: etag },
  });
}
