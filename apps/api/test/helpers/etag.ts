// SPDX-License-Identifier: Apache-2.0

/**
 * Conditional-request helpers for tests. A draft's version rides in its
 * `ETag` (`"<lock_version>"`, strong) and goes back as `If-Match`; tests seed
 * rows by `lockVersion`, so they spell the header from it.
 */

/** The `If-Match` header naming draft version `version`. */
export function ifMatch(version: number | null | undefined): Record<string, string> {
  if (version == null) throw new Error("ifMatch: no draft version to name");
  return { "If-Match": `"${version}"` };
}

/** The draft version a response's `ETag` names — the test knows the format. */
export function etagVersion(res: Response): number {
  const etag = res.headers.get("ETag");
  if (!etag) throw new Error(`no ETag on ${res.status} response`);
  return Number(JSON.parse(etag));
}
