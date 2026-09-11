// SPDX-License-Identifier: Apache-2.0

/**
 * Shared assertion for request-body refusals.
 *
 * A bare `expect(res.status).toBe(400)` is a weak assertion on a launch surface:
 * it still passes when the request started failing for an unrelated reason — a
 * guard reordered, a middleware rejecting earlier, an auth/context change — so
 * the test stays green while the schema rule it was written for silently stopped
 * firing. Pinning the RFC-9457 `code` AND the offending `errors[].field` makes
 * the assertion name the exact schema rule under test.
 *
 * Originally written inline in `routes/schedules-body-validation.test.ts`;
 * lifted here so `routes/runs-body-validation.test.ts` — the sibling covering
 * the other three launch surfaces — asserts the same way. Both launch-surface
 * suites now import it, so the four surfaces refuse a body under one assertion.
 */

import { expect } from "bun:test";

/** RFC-9457 problem body shape the API answers a body refusal with. */
interface ProblemBody {
  code: string;
  errors?: Array<{ field: string }>;
}

/**
 * Assert a body-validation refusal (`validation_failed`) AND which field it
 * blamed. `field` is the rendered Zod path —
 * `"connection_overrides.@acme/gmail"` for a nested issue, and for a
 * `.strict()` unrecognized key the OFFENDING KEY itself (`"config"`,
 * `"source_code"`, …). That last case used to render as the flat `"body"`:
 * Zod reports `unrecognized_keys` with an EMPTY path and the names in
 * `issue.keys`, which `zodIssuesToFieldErrors` (`@appstrate/core/api-errors`)
 * now reads. `"body"` remains the pointer for a genuinely path-less issue with
 * no caller-supplied `param` — a whole-body type failure, say.
 */
export async function expectRejectedField(res: Response, field: string): Promise<void> {
  expect(res.status).toBe(400);
  const body = (await res.json()) as ProblemBody;
  expect(body.code).toBe("validation_failed");
  expect(body.errors?.map((e) => e.field)).toContain(field);
}
