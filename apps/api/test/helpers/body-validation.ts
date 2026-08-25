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
 * blamed. `field` is the rendered Zod path — `"body"` for a whole-body issue
 * such as a `.strict()` unrecognized key, `"connection_overrides.@acme/gmail"`
 * for a nested one.
 */
export async function expectRejectedField(res: Response, field: string): Promise<void> {
  expect(res.status).toBe(400);
  const body = (await res.json()) as ProblemBody;
  expect(body.code).toBe("validation_failed");
  expect(body.errors?.map((e) => e.field)).toContain(field);
}
