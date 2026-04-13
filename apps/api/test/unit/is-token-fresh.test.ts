// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { isTokenFresh } from "../../src/routes/internal.ts";

const SEC = 1_000;
const MIN = 60 * SEC;

describe("isTokenFresh", () => {
  it("returns false for null", () => {
    expect(isTokenFresh(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isTokenFresh(undefined)).toBe(false);
  });

  it("returns false for an unparseable string", () => {
    expect(isTokenFresh("not-a-date")).toBe(false);
  });

  it("returns false when expiresAt is in the past", () => {
    const pastIso = new Date(Date.now() - 5 * MIN).toISOString();
    expect(isTokenFresh(pastIso)).toBe(false);
  });

  it("returns false when expiresAt is exactly now", () => {
    expect(isTokenFresh(new Date())).toBe(false);
  });

  it("returns false when expiresAt is within the 60s safety margin", () => {
    const iso = new Date(Date.now() + 30 * SEC).toISOString();
    expect(isTokenFresh(iso)).toBe(false);
  });

  it("returns false exactly at the threshold boundary (60s)", () => {
    // >, not >= — exactly 60s remaining should NOT count as fresh
    const iso = new Date(Date.now() + 60 * SEC).toISOString();
    expect(isTokenFresh(iso)).toBe(false);
  });

  it("returns true when expiresAt is beyond the threshold", () => {
    const iso = new Date(Date.now() + 61 * SEC).toISOString();
    expect(isTokenFresh(iso)).toBe(true);
  });

  it("returns true when expiresAt is 5 minutes away", () => {
    const iso = new Date(Date.now() + 5 * MIN).toISOString();
    expect(isTokenFresh(iso)).toBe(true);
  });

  it("returns true when expiresAt is 1 hour away (typical OAuth2 token)", () => {
    const iso = new Date(Date.now() + 60 * MIN).toISOString();
    expect(isTokenFresh(iso)).toBe(true);
  });

  it("accepts a Date instance directly", () => {
    expect(isTokenFresh(new Date(Date.now() + 10 * MIN))).toBe(true);
    expect(isTokenFresh(new Date(Date.now() - 10 * MIN))).toBe(false);
  });
});
