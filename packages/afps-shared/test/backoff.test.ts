// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { computeBackoffDelayMs, isRetryableHttpStatus } from "../src/backoff.ts";

describe("computeBackoffDelayMs", () => {
  it("doubles per attempt from baseMs", () => {
    const opts = { baseMs: 100, capMs: 10_000 };
    expect(computeBackoffDelayMs(1, opts)).toBe(100);
    expect(computeBackoffDelayMs(2, opts)).toBe(200);
    expect(computeBackoffDelayMs(3, opts)).toBe(400);
    expect(computeBackoffDelayMs(4, opts)).toBe(800);
  });

  it("caps the exponential term at capMs", () => {
    const opts = { baseMs: 500, capMs: 2000 };
    expect(computeBackoffDelayMs(1, opts)).toBe(500);
    expect(computeBackoffDelayMs(2, opts)).toBe(1000);
    expect(computeBackoffDelayMs(3, opts)).toBe(2000);
    expect(computeBackoffDelayMs(10, opts)).toBe(2000);
  });

  it("adds at most jitterRatio of the capped delay", () => {
    const opts = { baseMs: 1000, capMs: 10_000, jitterRatio: 0.25 };
    expect(computeBackoffDelayMs(1, { ...opts, random: () => 0 })).toBe(1000);
    expect(computeBackoffDelayMs(1, { ...opts, random: () => 1 })).toBe(1250);
    expect(computeBackoffDelayMs(1, { ...opts, random: () => 0.5 })).toBe(1125);
  });

  it("clamps attempt below 1 to attempt 1", () => {
    const opts = { baseMs: 100, capMs: 10_000 };
    expect(computeBackoffDelayMs(0, opts)).toBe(100);
    expect(computeBackoffDelayMs(-3, opts)).toBe(100);
  });

  it("returns an integer even with fractional jitter", () => {
    const delay = computeBackoffDelayMs(1, {
      baseMs: 333,
      capMs: 10_000,
      jitterRatio: 0.25,
      random: () => 0.7,
    });
    expect(Number.isInteger(delay)).toBe(true);
  });
});

describe("isRetryableHttpStatus", () => {
  it("retries 5xx and 429", () => {
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(502)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(429)).toBe(true);
  });

  it("does not retry deterministic statuses", () => {
    for (const status of [200, 201, 301, 400, 401, 403, 404, 408, 409, 410, 422]) {
      expect(isRetryableHttpStatus(status)).toBe(false);
    }
  });
});
