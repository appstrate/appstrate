// SPDX-License-Identifier: Apache-2.0

/**
 * `If-None-Match` evaluation, RFC 9110 §13.1.2.
 *
 * Lives in `lib/` rather than next to either caller: both the OpenAPI spec
 * route and the package file explorer answer conditional GETs, and each had
 * grown its own copy of the same comma-split / trim / strip-`W/` / compare
 * chain. They are one algorithm with one parameter, not two algorithms.
 */

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
