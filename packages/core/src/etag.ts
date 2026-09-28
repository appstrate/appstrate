// SPDX-License-Identifier: Apache-2.0

/**
 * The strong entity-tag of a versioned representation (RFC 9110 §8.8.3): the
 * platform stamps a package draft's `lock_version` as `"<n>"`, and a client
 * that pins what it read parses it back. One producer, one parser.
 */

/** The strong `ETag` of `version`. */
export function versionEtag(version: number): string {
  return `"${version}"`;
}

/** The version a {@link versionEtag} carries; `null` for any tag it does not produce. */
export function parseVersionEtag(etag: string | null | undefined): number | null {
  const version = Number(/^"(\d+)"$/.exec(etag ?? "")?.[1]);
  return Number.isSafeInteger(version) && versionEtag(version) === etag ? version : null;
}
