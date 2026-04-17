// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import {
  _resetRunLimitsForTesting,
  _setRunLimitsForTesting,
  getPlatformRunLimits,
  getInlineRunLimits,
} from "../../src/services/run-limits.ts";

describe("run-limits registry", () => {
  beforeEach(() => {
    _resetRunLimitsForTesting();
  });

  it("throws before init() to catch bootstrap-ordering bugs", () => {
    expect(() => getPlatformRunLimits()).toThrow(/not initialized/i);
    expect(() => getInlineRunLimits()).toThrow(/not initialized/i);
  });

  it("applies documented defaults when no overrides are provided", () => {
    _setRunLimitsForTesting({}, {});
    const platform = getPlatformRunLimits();
    const inline = getInlineRunLimits();

    expect(platform.timeout_ceiling_seconds).toBe(1800);
    expect(platform.per_org_global_rate_per_min).toBe(200);
    expect(platform.max_concurrent_per_org).toBe(50);

    expect(inline.rate_per_min).toBe(60);
    expect(inline.manifest_bytes).toBe(65536);
    expect(inline.prompt_chars).toBe(200_000);
    expect(inline.max_skills).toBe(20);
    expect(inline.max_tools).toBe(20);
    expect(inline.max_authorized_uris).toBe(50);
    expect(inline.wildcard_uri_allowed).toBe(false);
    expect(inline.retention_days).toBe(30);
  });

  it("accepts partial overrides and keeps defaults for unset keys", () => {
    _setRunLimitsForTesting({ timeout_ceiling_seconds: 600 }, { rate_per_min: 10 });
    expect(getPlatformRunLimits().timeout_ceiling_seconds).toBe(600);
    expect(getPlatformRunLimits().per_org_global_rate_per_min).toBe(200);
    expect(getInlineRunLimits().rate_per_min).toBe(10);
    expect(getInlineRunLimits().manifest_bytes).toBe(65536);
  });

  it("rejects zero / negative caps (must be positive integers)", () => {
    expect(() => _setRunLimitsForTesting({ timeout_ceiling_seconds: 0 }, {})).toThrow();
    expect(() => _setRunLimitsForTesting({ max_concurrent_per_org: -1 }, {})).toThrow();
    expect(() => _setRunLimitsForTesting({}, { rate_per_min: 0 })).toThrow();
  });
});
