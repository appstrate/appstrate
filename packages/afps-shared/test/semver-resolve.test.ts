// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Behaviour matrix for the canonical 3-step `resolveVersionString`
 * (exact → dist-tag → range). Formerly the afps-runtime ↔ core parity test;
 * with a single shared source there is exactly one implementation to pin.
 */

import { describe, it, expect } from "bun:test";
import { resolveVersionString } from "../src/semver-resolve.ts";

interface Case {
  name: string;
  query: string;
  exact: string[];
  range: string[];
  distTags: Record<string, string>;
  expected: string | null;
}

const CASES: Case[] = [
  // 1. Exact match
  {
    name: "exact hit",
    query: "1.2.3",
    exact: ["1.2.3", "1.0.0"],
    range: ["1.2.3"],
    distTags: {},
    expected: "1.2.3",
  },
  {
    name: "exact miss → null",
    query: "9.9.9",
    exact: ["1.2.3"],
    range: ["1.2.3"],
    distTags: {},
    expected: null,
  },
  {
    name: "exact pin resolves even when not in range set (yanked)",
    query: "1.2.3",
    exact: ["1.2.3"],
    range: [],
    distTags: {},
    expected: "1.2.3",
  },
  // 2. Dist-tag
  {
    name: "dist-tag hit",
    query: "latest",
    exact: ["1.0.0", "2.0.0"],
    range: ["1.0.0", "2.0.0"],
    distTags: { latest: "2.0.0" },
    expected: "2.0.0",
  },
  {
    name: "dist-tag target filtered out → null (no range fallback)",
    query: "latest",
    exact: ["1.0.0"],
    range: ["1.0.0"],
    distTags: { latest: "9.9.9" },
    expected: null,
  },
  {
    name: "dist-tag points at exact-only (yanked-but-pinned) target",
    query: "beta",
    exact: ["3.0.0"],
    range: [],
    distTags: { beta: "3.0.0" },
    expected: "3.0.0",
  },
  // 3. Semver range
  {
    name: "caret range picks max satisfying",
    query: "^1.0.0",
    exact: ["1.0.0", "1.5.0", "2.0.0"],
    range: ["1.0.0", "1.5.0", "2.0.0"],
    distTags: {},
    expected: "1.5.0",
  },
  {
    name: "range with no satisfying version → null",
    query: "^5.0.0",
    exact: ["1.0.0"],
    range: ["1.0.0"],
    distTags: {},
    expected: null,
  },
  {
    name: "tilde range",
    query: "~1.2.0",
    exact: ["1.2.0", "1.2.9", "1.3.0"],
    range: ["1.2.0", "1.2.9", "1.3.0"],
    distTags: {},
    expected: "1.2.9",
  },
  {
    name: "x-range",
    query: "1.x",
    exact: ["1.0.0", "1.9.0", "2.0.0"],
    range: ["1.0.0", "1.9.0", "2.0.0"],
    distTags: {},
    expected: "1.9.0",
  },
  {
    name: "range skips invalid version strings in the range set",
    query: "^1.0.0",
    exact: ["1.0.0", "not-a-version", "1.4.0"],
    range: ["1.0.0", "not-a-version", "1.4.0"],
    distTags: {},
    expected: "1.4.0",
  },
  // Garbage / empty
  {
    name: "garbage query → null",
    query: "@@@",
    exact: ["1.0.0"],
    range: ["1.0.0"],
    distTags: {},
    expected: null,
  },
  {
    name: "empty everything → null",
    query: "1.0.0",
    exact: [],
    range: [],
    distTags: {},
    expected: null,
  },
  {
    name: "star range picks max",
    query: "*",
    exact: ["1.0.0", "2.3.4"],
    range: ["1.0.0", "2.3.4"],
    distTags: {},
    expected: "2.3.4",
  },
];

describe("resolveVersionString", () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(resolveVersionString(c.query, c.exact, c.range, c.distTags)).toBe(c.expected);
    });
  }
});
