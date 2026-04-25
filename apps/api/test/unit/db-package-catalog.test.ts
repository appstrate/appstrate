// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the resolver logic inside {@link DbPackageCatalog}.
 *
 * The full resolve+fetch path hits the DB and S3/FS storage; that
 * integration path is exercised by routes/runs.ts integration tests.
 * Here we directly verify the 3-step resolution policy (exact →
 * dist-tag → semver range) on synthetic row sets.
 */

import { describe, it, expect } from "bun:test";
import { DbPackageCatalog, pickVersion } from "../../src/services/adapters/db-package-catalog.ts";
import type { PackageCatalog } from "@appstrate/afps-runtime/bundle";

const row = (version: string, integrity: string, yanked = false) => ({
  version,
  integrity,
  yanked,
});

describe("pickVersion — 3-step resolution", () => {
  it("resolves an exact version (yanked allowed on exact pin)", () => {
    const r = pickVersion("1.0.0", [row("1.0.0", "sha256-a", true), row("1.1.0", "sha256-b")], []);
    expect(r).toEqual({ version: "1.0.0", integrity: "sha256-a" });
  });

  it("returns null when exact version is not present", () => {
    expect(pickVersion("9.9.9", [row("1.0.0", "sha256-a")], [])).toBeNull();
  });

  it("resolves a dist-tag (excludes yanked)", () => {
    const r = pickVersion(
      "latest",
      [row("1.0.0", "sha256-a"), row("2.0.0", "sha256-b")],
      [{ tag: "latest", version: "2.0.0" }],
    );
    expect(r).toEqual({ version: "2.0.0", integrity: "sha256-b" });
  });

  it("ignores a dist-tag that points at a yanked version", () => {
    const r = pickVersion(
      "latest",
      [
        row("1.0.0", "sha256-a"),
        row("2.0.0", "sha256-b", true), // yanked
      ],
      [{ tag: "latest", version: "2.0.0" }],
    );
    // Does NOT fall through to semver range — `latest` is not a range.
    expect(r).toBeNull();
  });

  it("resolves a semver range (picks max satisfying, excludes yanked)", () => {
    const r = pickVersion(
      "^1.0.0",
      [
        row("1.0.0", "sha256-a"),
        row("1.5.0", "sha256-b"),
        row("1.7.0", "sha256-c", true), // yanked — skipped
        row("2.0.0", "sha256-d"),
      ],
      [],
    );
    expect(r).toEqual({ version: "1.5.0", integrity: "sha256-b" });
  });

  it("returns null when no version satisfies the range", () => {
    expect(pickVersion("^3", [row("1.0.0", "sha256-a")], [])).toBeNull();
  });

  it("returns null for an empty row set", () => {
    expect(pickVersion("1.0.0", [], [])).toBeNull();
  });
});

describe("DbPackageCatalog — interface shape", () => {
  it("implements the PackageCatalog contract", () => {
    const cat: PackageCatalog = new DbPackageCatalog({
      orgId: "00000000-0000-0000-0000-000000000000",
    });
    expect(typeof cat.resolve).toBe("function");
    expect(typeof cat.fetch).toBe("function");
  });
});
