// SPDX-License-Identifier: Apache-2.0

/**
 * Conditional requests, RFC 9110 §13 — both halves in one place: the
 * `If-None-Match` read side (the OpenAPI spec route, the package file
 * explorer) and the `If-Match` write side, the platform's ONE optimistic
 * concurrency mechanism. A mutable resource sends a strong `ETag` minted by
 * {@link versionEtag} and a writer echoes it in `If-Match`.
 */

import type { Context } from "hono";
import { ApiError } from "@appstrate/core/api-errors";

interface IfNoneMatchOptions {
  /**
   * Whether `*` counts as a match. Default `true`, which is the plain reading
   * of the RFC: `*` means "if any current representation exists".
   *
   * `false` is for a short-circuit taken BEFORE the server knows whether the
   * representation exists — the pre-read check on the package-file content
   * route. Honouring `*` there would turn `?path=does-not-exist` into a `304`
   * and tell the caller a file exists. Once existence is established, `*` is
   * fine and the default applies.
   */
  allowWildcard?: boolean;
}

/**
 * True when `header` carries `*` (unless disabled) or an entity-tag that
 * matches `etag` under the weak comparison function — the comparison RFC 9110
 * §13.1.2 mandates for `If-None-Match`, where `W/"x"` and `"x"` are the same
 * tag.
 *
 * `etag` is expected already quoted, exactly as it goes out on the wire; the
 * quotes take part in the comparison, so a tag is never a match for a prefix
 * of itself.
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

/**
 * The strong entity-tag of one version. A timestamp is taken at its
 * millisecond — the precision a `Date` round-trips through — so the tag of a
 * row read back is the tag of the row written.
 */
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
 * Evaluate `If-Match` (RFC 9110 §13.1.1) against the resource's CURRENT
 * version. Strong comparison, so a weak `W/` tag never matches; `*` matches
 * any existing representation. Absent header: a no-op, or `428` when the
 * route makes the precondition mandatory (RFC 6585 §3). A mismatch is `412`,
 * carrying the current `ETag` so the client can re-read and retry.
 *
 * Call it where the version is read under the same lock as the write, when
 * the route has one — the draft save passes it into the service for that.
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
  throw new ApiError({
    status: 412,
    code: "precondition_failed",
    title: "Precondition Failed",
    detail:
      "The resource changed since you read it: If-Match does not match its current ETag. Re-read it, reapply your change, and send the new ETag.",
    headers: { ETag: etag },
  });
}
