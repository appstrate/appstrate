// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical request-body reader for JSON routes.
 *
 * Two failure modes are handled inconsistently by hand-rolled readers, both
 * yielding a 500 that should have been a 400:
 *
 *  1. `await c.req.json()` on a malformed / truncated / empty body throws a raw
 *     `SyntaxError`, which a global error handler maps to `internalError()`
 *     (500) instead of a client 400.
 *  2. `c.req.json<T>()` casts without validating, so a well-formed-JSON-but-
 *     wrong-shape body (`{ content: 1 }`) slips past TypeScript and blows up
 *     later (`content.trim is not a function`) — again a 500.
 *
 * `readJsonBody` closes both: it reads the body catching parse errors as a 400,
 * then runs the Zod schema through `parseBody` (400 with RFC-9457 `errors[]` on
 * shape mismatch). Every JSON route should use this instead of a bare
 * `c.req.json()` + cast.
 *
 * Routes whose body is genuinely optional (all-optional schema, empty body ==
 * "no changes") pass `{ allowEmpty: true }`: a missing/whitespace-only body
 * becomes `{}` and validates, while MALFORMED JSON still 400s. This replaces the
 * `c.req.json().catch(() => ({}))` dialect, which silently swallowed malformed
 * JSON into `{}` and could mask a broken request as a bad-shape (or accepted) one.
 *
 * It lives in core rather than in `apps/api` because a module cannot import
 * from the platform's source tree: without this, every module route re-derives
 * the malformed/invalid split by hand, and each copy phrases its own 400 —
 * which is how one of them ended up reporting every schema failure as
 * "plan_id is required". Hono is an optional peer dependency of this package
 * and only its `Context` TYPE is touched here.
 */

import type { Context } from "hono";
import type { z } from "zod";
import { invalidRequest, parseBody } from "./api-errors.ts";

/** Options for {@link readJsonBody}. */
export interface ReadJsonBodyOptions {
  /** Field-path prefix forwarded to `parseBody` for nested error reporting. */
  param?: string;
  /** Treat a missing / whitespace-only body as `{}` instead of a 400. */
  allowEmpty?: boolean;
}

/**
 * Read + validate a JSON request body. Throws `invalidRequest` (400) on
 * unparseable JSON and `validationFailed` (400) on schema mismatch.
 */
export async function readJsonBody<T extends z.ZodType>(
  c: Context,
  schema: T,
  opts: ReadJsonBodyOptions = {},
): Promise<z.output<T>> {
  const { param, allowEmpty } = opts;

  let raw: unknown;
  if (allowEmpty) {
    // Read the raw text so an empty body can be distinguished from malformed
    // JSON: empty → `{}` (validate), non-empty-but-unparseable → 400.
    const text = await c.req.text();
    if (text.trim() === "") {
      raw = {};
    } else {
      try {
        raw = JSON.parse(text);
      } catch {
        throw invalidRequest("Request body is not valid JSON");
      }
    }
  } else {
    try {
      raw = await c.req.json();
    } catch {
      throw invalidRequest("Request body is not valid JSON");
    }
  }
  return parseBody(schema, raw, param);
}
