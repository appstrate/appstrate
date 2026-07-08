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
 */

import type { Context } from "hono";
import type { z } from "zod";
import { invalidRequest, parseBody } from "@appstrate/core/api-errors";

/**
 * Read + validate a JSON request body. Throws `invalidRequest` (400) on
 * unparseable JSON and `validationFailed` (400) on schema mismatch.
 *
 * @param param optional field-path prefix forwarded to `parseBody` for nested
 *   error reporting.
 */
export async function readJsonBody<T extends z.ZodType>(
  c: Context,
  schema: T,
  param?: string,
): Promise<z.output<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw invalidRequest("Request body is not valid JSON");
  }
  return parseBody(schema, raw, param);
}
