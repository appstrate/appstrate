import { describe, expect, test } from "bun:test";
import {
  computeIntegrity,
  verifyArtifactIntegrity,
  buildDownloadHeaders,
} from "../src/integrity.ts";

describe("verifyArtifactIntegrity", () => {
  test("returns valid: true when integrity matches", () => {
    const data = new TextEncoder().encode("hello world");
    const integrity = computeIntegrity(data);
    const result = verifyArtifactIntegrity(data, integrity);
    expect(result.valid).toBe(true);
    expect(result.computed).toBe(integrity);
  });

  test("returns valid: false when integrity does not match", () => {
    const data = new TextEncoder().encode("hello world");
    const result = verifyArtifactIntegrity(data, "sha256-WRONG");
    expect(result.valid).toBe(false);
    expect(result.computed).toMatch(/^sha256-/);
    expect(result.computed).not.toBe("sha256-WRONG");
  });

  test("computed field always contains the actual hash", () => {
    const data = new TextEncoder().encode("test");
    const expected = computeIntegrity(data);
    const result = verifyArtifactIntegrity(data, "sha256-bogus");
    expect(result.computed).toBe(expected);
  });
});

describe("buildDownloadHeaders", () => {
  test("includes Content-Type, X-Integrity, and Content-Disposition", () => {
    const headers = buildDownloadHeaders({
      integrity: "sha256-abc123",
      yanked: false,
      scope: "demo",
      name: "my-flow",
      version: "1.0.0",
    });
    expect(headers["Content-Type"]).toBe("application/afps+zip");
    expect(headers["X-Integrity"]).toBe("sha256-abc123");
    expect(headers["Content-Disposition"]).toBe('attachment; filename="demo-my-flow-1.0.0.afps"');
    expect(headers["X-Yanked"]).toBeUndefined();
  });

  test("includes X-Yanked when yanked is true", () => {
    const headers = buildDownloadHeaders({
      integrity: "sha256-abc123",
      yanked: true,
      scope: "@org",
      name: "pkg",
      version: "2.0.0",
    });
    expect(headers["X-Yanked"]).toBe("true");
    expect(headers["Content-Disposition"]).toBe('attachment; filename="org-pkg-2.0.0.afps"');
  });

  test("does not include X-Yanked when yanked is false", () => {
    const headers = buildDownloadHeaders({
      integrity: "sha256-xyz",
      yanked: false,
      scope: "test",
      name: "lib",
      version: "0.1.0",
    });
    expect("X-Yanked" in headers).toBe(false);
  });
});
