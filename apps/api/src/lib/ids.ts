// SPDX-License-Identifier: Apache-2.0

import { invalidRequest } from "./errors.ts";

/** Generate a prefixed UUID (e.g. "wh_abc-123", "spc_def-456"). */
export function prefixedId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Strict space id shape: `spc_` + a canonical lowercase dashed UUID — exactly
 * what `prefixedId("spc")` mints (`crypto.randomUUID()`), and nothing else.
 *
 * Why a regex at all: the id prefix was `app_` until the space rename, and
 * without a shape check an `app_` id that a data migration failed to rewrite
 * does NOT 404 — the header, the API key's bound id and the `spaces` row all
 * still agree with each other, so a half-finished migration keeps working and
 * says nothing. The regex turns that silence into a loud failure. Mirrors
 * `FILE_ID_RE` (`packages/core/src/file-uri.ts`), which exists for the same
 * reason on the equivalent `file_` id.
 *
 * One shape is written and the same one is read: `app_` is REJECTED, never
 * accepted-and-warned (`docs/NO_TRANSITIONAL_CODE.md` §1).
 *
 * Note: a second, differently-shaped generator exists in
 * `apps/api/test/helpers/auth.ts` — it mints `app_` + a 16-char DASHLESS uuid
 * slice. That fixture cannot satisfy this regex on either count, and that is
 * deliberate: the canonical mint shape is the one form, and the helper is to be
 * rewritten to `prefixedId("spc")` (or `spc_` + a full dashed UUID) in the test
 * pass that follows. Widening the regex to admit the dashless slice would make
 * the retired shape legal forever, which is exactly what this guard exists to
 * prevent.
 */
export const SPACE_ID_RE = /^spc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Throw unless `id` is a canonical space id. `param` names the field the id
 * arrived on so the 400 points at it (`X-Space-Id`, `space_id`, …).
 *
 * The `app_` case gets its own message on purpose: an operator reading the log
 * must be able to tell "a client sent garbage" apart from "the `app_` → `spc_`
 * data migration has not run on this deployment".
 */
export function assertSpaceId(id: string, param = "space_id"): void {
  if (SPACE_ID_RE.test(id)) return;
  if (id.startsWith("app_")) {
    throw invalidRequest(
      `Space id '${id}' uses the retired \`app_\` prefix. Space ids are \`spc_\` + a UUID; ` +
        `this deployment still holds pre-rename data — run the \`app_\` → \`spc_\` id migration.`,
      param,
    );
  }
  throw invalidRequest(
    `Malformed space id '${id}'. Expected \`spc_\` followed by a canonical UUID.`,
    param,
  );
}
