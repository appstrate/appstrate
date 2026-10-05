// SPDX-License-Identifier: Apache-2.0

/**
 * The `scopes` member of `POST /api/api-keys`. Omitted, the server grants
 * everything the creator may delegate — so it is omitted only when every
 * available scope was picked, and a key never gets that by leaving the form
 * untouched: the selection starts empty.
 */
export function apiKeyScopesBody(
  selected: readonly string[],
  available: readonly string[],
): string[] | undefined {
  const picked = new Set(selected);
  const everything = available.length > 0 && available.every((scope) => picked.has(scope));
  return everything ? undefined : [...selected];
}
