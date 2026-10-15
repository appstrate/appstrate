// SPDX-License-Identifier: Apache-2.0

/** A location's `search` written from `params`: `?a=1`, or nothing when it holds none. */
export function searchOf(params: URLSearchParams): string {
  const query = params.toString();
  return query ? `?${query}` : "";
}
