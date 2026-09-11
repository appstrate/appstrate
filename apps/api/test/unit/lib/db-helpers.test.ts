// SPDX-License-Identifier: Apache-2.0

/**
 * `isForeignKeyViolation` is what turns a referential-integrity failure into a
 * readable 409 (`role_in_use`, `credential_in_use`) instead of a 500. It has to
 * see through the wrapper Drizzle puts around the driver error, and it has to
 * accept the code PGlite raises for `ON DELETE RESTRICT` as well as the one a
 * real Postgres raises — the tier-0 suite runs on the former.
 */

import { describe, expect, it } from "bun:test";
import { isForeignKeyViolation } from "../../../src/lib/db-helpers.ts";

/** How Drizzle surfaces a driver failure: a wrapper with no code of its own. */
function drizzleWrapped(code: string): Error {
  const driver = Object.assign(new Error("driver error"), { code });
  return Object.assign(new Error("Failed query"), { cause: driver });
}

describe("isForeignKeyViolation", () => {
  it("matches 23503 (postgres) and 23001 (PGlite ON DELETE RESTRICT)", () => {
    expect(isForeignKeyViolation({ code: "23503" })).toBe(true);
    expect(isForeignKeyViolation({ code: "23001" })).toBe(true);
  });

  it("sees the code through the Drizzle wrapper", () => {
    expect(isForeignKeyViolation(drizzleWrapped("23503"))).toBe(true);
    expect(isForeignKeyViolation(drizzleWrapped("23001"))).toBe(true);
  });

  it("rejects neighbouring integrity codes and non-DB errors", () => {
    expect(isForeignKeyViolation(drizzleWrapped("23505"))).toBe(false);
    expect(isForeignKeyViolation({ code: "22P02" })).toBe(false);
    expect(isForeignKeyViolation(new Error("boom"))).toBe(false);
    expect(isForeignKeyViolation(null)).toBe(false);
    expect(isForeignKeyViolation("23503")).toBe(false);
  });
});
