// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  BUNDLE_FORMAT_VERSION,
  formatPackageIdentity,
  parsePackageIdentity,
} from "../../src/bundle/types.ts";

describe("parsePackageIdentity", () => {
  it("parses a canonical identity", () => {
    const p = parsePackageIdentity("@acme/widget@1.2.3");
    expect(p).toEqual({
      scope: "acme",
      name: "widget",
      version: "1.2.3",
      packageId: "@acme/widget",
    });
  });

  it("handles versions with pre-release + build metadata", () => {
    const p = parsePackageIdentity("@scope/pkg@1.2.3-beta.1+build.5");
    expect(p?.version).toBe("1.2.3-beta.1+build.5");
  });

  it("returns null for missing scope", () => {
    expect(parsePackageIdentity("widget@1.0.0")).toBeNull();
  });

  it("returns null for missing version", () => {
    expect(parsePackageIdentity("@acme/widget@")).toBeNull();
  });

  it("returns null for missing name", () => {
    expect(parsePackageIdentity("@acme/@1.0.0")).toBeNull();
  });

  it("returns null for non-string input", () => {
    // @ts-expect-error deliberate bad input
    expect(parsePackageIdentity(null)).toBeNull();
    // @ts-expect-error deliberate bad input
    expect(parsePackageIdentity(42)).toBeNull();
  });

  it("returns null for strings above 4 KiB", () => {
    const big = `@${"a".repeat(5000)}/x@1.0.0`;
    expect(parsePackageIdentity(big)).toBeNull();
  });
});

describe("formatPackageIdentity", () => {
  it("joins packageId + version", () => {
    expect(formatPackageIdentity("@me/x", "2.0.0")).toBe("@me/x@2.0.0");
  });
});

describe("BUNDLE_FORMAT_VERSION", () => {
  it("is the v1.0 constant", () => {
    expect(BUNDLE_FORMAT_VERSION).toBe("1.0");
  });
});
