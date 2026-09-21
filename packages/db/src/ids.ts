// SPDX-License-Identifier: Apache-2.0

/**
 * Row-id minting, and the shape guard for the one id clients supply.
 *
 * It lives in `packages/db` rather than in `apps/api/src/lib` because
 * `provision-org.ts` next door mints space ids before any API service exists
 * and cannot import from `apps/api` — it hand-rolled `spc_${randomUUID()}` for
 * exactly that reason, which is a second mint shape for an id whose whole
 * contract is that there is only one.
 */

/** Generate a prefixed UUID (e.g. "wh_abc-123", "spc_def-456"). */
export function prefixedId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Strict space id shape: `spc_` + a canonical lowercase dashed UUID — exactly
 * what `prefixedId("spc")` mints (`crypto.randomUUID()`), and nothing else.
 *
 * Why a regex at all: without a shape check, an id whose prefix is wrong does
 * NOT 404 — the header, the API key's bound id and the `spaces` row can all
 * still agree with each other, so a malformed id keeps working and says
 * nothing. The regex turns that silence into a loud failure. Mirrors
 * `FILE_ID_RE` (`packages/core/src/file-uri.ts`), which exists for the same
 * reason on the equivalent `file_` id.
 *
 * There is one mint shape and this regex is it: fixtures go through
 * `prefixedId("spc")` like everything else, rather than hand-rolling a lookalike.
 * Widening this to admit a second shape — a dashless slice, a shorter id — would
 * make that shape legal forever, which is what the guard exists to prevent.
 */
export const SPACE_ID_RE = /^spc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
