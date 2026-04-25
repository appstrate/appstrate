// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the central deprecation header builders (Phase 6 of #276).
 *
 * The sidecar's `deprecation.ts` re-exports the same constants — both
 * suites cover the same contract from different angles. Anything that
 * regresses here is a regression at every consumer.
 */

import { describe, it, expect } from "bun:test";
import {
  DEPRECATIONS,
  DEPRECATION_DATE_V2,
  MIGRATION_GUIDE_URL,
  SUNSET_DATE_V2,
  deprecationHeaders,
} from "../src/index.ts";

describe("DEPRECATIONS registry", () => {
  it("lists the two V2 surfaces", () => {
    expect(Object.keys(DEPRECATIONS).sort()).toEqual([
      "legacy-binary-passthrough",
      "legacy-llm-routes",
    ]);
  });

  it("Sunset is at least 18 months past Deprecation for every entry", () => {
    const eighteenMonths = 18 * 30 * 24 * 60 * 60 * 1000;
    for (const id of Object.keys(DEPRECATIONS) as Array<keyof typeof DEPRECATIONS>) {
      const entry = DEPRECATIONS[id];
      expect(entry.sunset.getTime() - entry.deprecation.getTime()).toBeGreaterThanOrEqual(
        eighteenMonths,
      );
    }
  });
});

describe("deprecationHeaders()", () => {
  it("returns RFC 9745 Deprecation, RFC 8594 Sunset, and Link header", () => {
    const h = deprecationHeaders("legacy-llm-routes");
    expect(h.Deprecation).toBe(DEPRECATION_DATE_V2.toUTCString());
    expect(h.Sunset).toBe(SUNSET_DATE_V2.toUTCString());
    expect(h.Link).toContain(MIGRATION_GUIDE_URL);
    expect(h.Link).toContain('rel="sunset"');
    expect(h.Link).toContain('type="text/markdown"');
  });

  it("emits IMF-fixdate (UTC, RFC 9110 §5.6.7) format", () => {
    const h = deprecationHeaders("legacy-llm-routes");
    // Round-trip through Date.parse — invalid input would yield NaN.
    expect(Number.isNaN(Date.parse(h.Deprecation))).toBe(false);
    expect(Number.isNaN(Date.parse(h.Sunset))).toBe(false);
    expect(h.Deprecation.endsWith("GMT")).toBe(true);
  });

  it("returns the same header set for both registered surfaces under V2", () => {
    expect(deprecationHeaders("legacy-llm-routes")).toEqual(
      deprecationHeaders("legacy-binary-passthrough"),
    );
  });
});
