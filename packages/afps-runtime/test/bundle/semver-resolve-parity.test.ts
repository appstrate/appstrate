// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Drift guard for the deliberate two-copy `resolveVersionString` (3-step semver
 * resolution). afps-runtime ships standalone and cannot take a runtime
 * dependency on `@appstrate/core`, so the function is intentionally mirrored
 * line-for-line in both packages (see the header comments at both sites).
 *
 * This test runs the same input matrix through both implementations and asserts
 * byte-identical output, so any divergence between the copies fails CI. Core is
 * pulled in as a devDependency for the test only — never a runtime dep.
 */

import { describe, it, expect } from "bun:test";
import { resolveVersionString as runtimeResolve } from "../../src/bundle/semver-resolve.ts";
import { resolveVersionString as coreResolve } from "@appstrate/core/semver";

interface Case {
  name: string;
  query: string;
  exact: string[];
  range: string[];
  distTags: Record<string, string>;
}

const CASES: Case[] = [
  // 1. Exact match
  { name: "exact hit", query: "1.2.3", exact: ["1.2.3", "1.0.0"], range: ["1.2.3"], distTags: {} },
  { name: "exact miss → null", query: "9.9.9", exact: ["1.2.3"], range: ["1.2.3"], distTags: {} },
  {
    name: "exact pin resolves even when not in range set (yanked)",
    query: "1.2.3",
    exact: ["1.2.3"],
    range: [],
    distTags: {},
  },
  // 2. Dist-tag
  {
    name: "dist-tag hit",
    query: "latest",
    exact: ["1.0.0", "2.0.0"],
    range: ["1.0.0", "2.0.0"],
    distTags: { latest: "2.0.0" },
  },
  {
    name: "dist-tag target filtered out → null (no range fallback)",
    query: "latest",
    exact: ["1.0.0"],
    range: ["1.0.0"],
    distTags: { latest: "9.9.9" },
  },
  {
    name: "dist-tag points at exact-only (yanked-but-pinned) target",
    query: "beta",
    exact: ["3.0.0"],
    range: [],
    distTags: { beta: "3.0.0" },
  },
  // 3. Semver range
  {
    name: "caret range picks max satisfying",
    query: "^1.0.0",
    exact: ["1.0.0", "1.5.0", "2.0.0"],
    range: ["1.0.0", "1.5.0", "2.0.0"],
    distTags: {},
  },
  {
    name: "range with no satisfying version → null",
    query: "^5.0.0",
    exact: ["1.0.0"],
    range: ["1.0.0"],
    distTags: {},
  },
  {
    name: "tilde range",
    query: "~1.2.0",
    exact: ["1.2.0", "1.2.9", "1.3.0"],
    range: ["1.2.0", "1.2.9", "1.3.0"],
    distTags: {},
  },
  {
    name: "x-range",
    query: "1.x",
    exact: ["1.0.0", "1.9.0", "2.0.0"],
    range: ["1.0.0", "1.9.0", "2.0.0"],
    distTags: {},
  },
  {
    name: "range skips invalid version strings in the range set",
    query: "^1.0.0",
    exact: ["1.0.0", "not-a-version", "1.4.0"],
    range: ["1.0.0", "not-a-version", "1.4.0"],
    distTags: {},
  },
  // Garbage / empty
  { name: "garbage query → null", query: "@@@", exact: ["1.0.0"], range: ["1.0.0"], distTags: {} },
  { name: "empty everything → null", query: "1.0.0", exact: [], range: [], distTags: {} },
  {
    name: "star range picks max",
    query: "*",
    exact: ["1.0.0", "2.3.4"],
    range: ["1.0.0", "2.3.4"],
    distTags: {},
  },
];

describe("resolveVersionString parity (afps-runtime ↔ @appstrate/core)", () => {
  for (const c of CASES) {
    it(`identical output: ${c.name}`, () => {
      const fromRuntime = runtimeResolve(c.query, c.exact, c.range, c.distTags);
      const fromCore = coreResolve(c.query, c.exact, c.range, c.distTags);
      expect(fromRuntime).toBe(fromCore);
    });
  }
});
