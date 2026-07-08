// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical request-body reader for JSON routes.
 *
 * Two failure modes were handled inconsistently across the API, both yielding
 * a 500 that should have been a 400:
 *
 *  1. `await c.req.json()` on a malformed / truncated / empty body throws a raw
 *     `SyntaxError`, which the global error handler maps to `internalError()`
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
 */

import type { Context } from "hono";
import type { z } from "zod";
import { invalidRequest, parseBody } from "@appstrate/core/api-errors";

/**
 * Options for {@link readJsonBody}. Passing a bare string is shorthand for
 * `{ param }` (kept for the existing positional callers).
 */
export interface ReadJsonBodyOptions {
  /** Field-path prefix forwarded to `parseBody` for nested error reporting. */
  param?: string;
  /** Treat a missing / whitespace-only body as `{}` instead of a 400. */
  allowEmpty?: boolean;
}

/**
 * Read + validate a JSON request body. Throws `invalidRequest` (400) on
 * unparseable JSON and `validationFailed` (400) on schema mismatch.
 *
 * @param opts either a field-path prefix (string, shorthand for `{ param }`)
 *   or a {@link ReadJsonBodyOptions} object.
 */
export async function readJsonBody<T extends z.ZodType>(
  c: Context,
  schema: T,
  opts?: string | ReadJsonBodyOptions,
): Promise<z.output<T>> {
  const { param, allowEmpty }: ReadJsonBodyOptions =
    typeof opts === "string" ? { param: opts } : (opts ?? {});

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
