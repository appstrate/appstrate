// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { rowValueErrorCode } from "../../../src/lib/db-helpers.ts";

/** How Drizzle surfaces a driver failure: a wrapper with no code of its own. */
function drizzleWrapped(code: string): Error {
  const driver = Object.assign(new Error("driver error"), { code });
  return Object.assign(new Error("Failed query"), { cause: driver });
}

describe("rowValueErrorCode", () => {
  it("returns a class-22 SQLSTATE, directly or through the Drizzle wrapper", () => {
    expect(rowValueErrorCode({ code: "22003" })).toBe("22003");
    expect(rowValueErrorCode({ cause: { code: "22P05" } })).toBe("22P05");
    expect(rowValueErrorCode(drizzleWrapped("22021"))).toBe("22021");
  });

  it("returns the CHECK violation code", () => {
    expect(rowValueErrorCode(drizzleWrapped("23514"))).toBe("23514");
  });

  it("returns null for other integrity violations, uncoded errors and non-objects", () => {
    expect(rowValueErrorCode(drizzleWrapped("23502"))).toBeNull();
    expect(rowValueErrorCode(drizzleWrapped("23505"))).toBeNull();
    expect(rowValueErrorCode(drizzleWrapped("23503"))).toBeNull();
    expect(rowValueErrorCode(drizzleWrapped("23001"))).toBeNull();
    expect(rowValueErrorCode(new Error("boom"))).toBeNull();
    expect(rowValueErrorCode({ code: 22003 })).toBeNull();
    expect(rowValueErrorCode(null)).toBeNull();
    expect(rowValueErrorCode("22P05")).toBeNull();
  });
});
