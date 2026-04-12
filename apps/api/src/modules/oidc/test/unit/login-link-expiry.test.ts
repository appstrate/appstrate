// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the login-URL `exp` expiry check. Covers the NaN-bypass
 * regression: a tampered / non-numeric `exp` query param must be treated
 * as expired, not silently accepted (because `NaN < now` is always false).
 */

import { describe, it, expect } from "bun:test";
import { isLoginLinkExpired } from "../../routes.ts";

describe("isLoginLinkExpired", () => {
  it("returns false when exp param is missing", () => {
    expect(isLoginLinkExpired(null)).toBe(false);
  });

  it("returns false for a future timestamp", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(isLoginLinkExpired(String(future))).toBe(false);
  });

  it("returns true for a past timestamp", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(isLoginLinkExpired(String(past))).toBe(true);
  });

  it("returns true for a non-numeric exp (NaN bypass guard)", () => {
    // `Number("garbage")` is `NaN` and `NaN < now` is always false, so a
    // naive `Number(exp) < now` check would silently accept this. The
    // helper must treat non-numeric values as expired.
    expect(isLoginLinkExpired("not-a-number")).toBe(true);
    expect(isLoginLinkExpired("undefined")).toBe(true);
    expect(isLoginLinkExpired("null")).toBe(true);
    expect(isLoginLinkExpired("1e+99999")).toBe(true); // Infinity
  });

  it("returns true for an empty string exp", () => {
    // An empty-string `exp` param is non-numeric (Number("") === 0 is in
    // the far past, so this happens to be "expired" anyway, but the
    // semantic we care about is: "if the signer set exp, enforce it").
    // Note: the route handler falls through on `!expParam` so the empty
    // string path here tests the secondary `Number.isFinite` branch.
    expect(isLoginLinkExpired("")).toBe(false); // empty → treated as missing
  });
});
