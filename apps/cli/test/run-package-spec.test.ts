// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `parseRunTarget` — splits the `appstrate run <arg>`
 * argument into a path or a package id. Detection is strict so an
 * accidentally-typed package id never silently resolves to a missing
 * file.
 */

import { describe, it, expect } from "bun:test";
import { parseRunTarget, PackageSpecError } from "../src/commands/run/package-spec.ts";

describe("parseRunTarget — package id", () => {
  it("parses @scope/name with no spec", () => {
    const target = parseRunTarget("@system/hello-world");
    expect(target).toEqual({
      kind: "id",
      packageId: "@system/hello-world",
      scope: "@system",
      name: "hello-world",
      spec: undefined,
    });
  });

  it("parses an exact semver spec", () => {
    expect(parseRunTarget("@scope/agent@1.2.3")).toMatchObject({
      kind: "id",
      packageId: "@scope/agent",
      spec: "1.2.3",
    });
  });

  it("parses a dist-tag spec", () => {
    expect(parseRunTarget("@scope/agent@beta")).toMatchObject({
      kind: "id",
      spec: "beta",
    });
  });

  it("parses a semver range spec", () => {
    expect(parseRunTarget("@scope/agent@^1.0.0")).toMatchObject({
      kind: "id",
      spec: "^1.0.0",
    });
  });
});

describe("parseRunTarget — path", () => {
  it("treats relative paths as paths", () => {
    expect(parseRunTarget("./agent.afps-bundle")).toEqual({
      kind: "path",
      path: "./agent.afps-bundle",
    });
  });

  it("treats absolute paths as paths", () => {
    expect(parseRunTarget("/tmp/agent.afps")).toEqual({
      kind: "path",
      path: "/tmp/agent.afps",
    });
  });

  it("treats unscoped names as paths (cwd-relative file)", () => {
    expect(parseRunTarget("bundle.afps")).toEqual({
      kind: "path",
      path: "bundle.afps",
    });
  });

  it("treats parent-relative paths as paths", () => {
    expect(parseRunTarget("../bundles/agent.afps")).toEqual({
      kind: "path",
      path: "../bundles/agent.afps",
    });
  });

  it("treats Windows drive paths as paths", () => {
    expect(parseRunTarget("C:\\tmp\\agent.afps")).toMatchObject({ kind: "path" });
  });
});

describe("parseRunTarget — invalid id", () => {
  it("rejects @scope without /name", () => {
    expect(() => parseRunTarget("@scope")).toThrow(PackageSpecError);
  });

  it("rejects @SCOPE/Name (uppercase)", () => {
    expect(() => parseRunTarget("@SCOPE/Name")).toThrow(PackageSpecError);
  });

  it("rejects @scope/ (empty name)", () => {
    expect(() => parseRunTarget("@scope/")).toThrow(PackageSpecError);
  });

  it("rejects empty input", () => {
    expect(() => parseRunTarget("")).toThrow(PackageSpecError);
    expect(() => parseRunTarget("   ")).toThrow(PackageSpecError);
  });
});
