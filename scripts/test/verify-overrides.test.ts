// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { checkOverrides, loadManifests, overrideFloor } from "../verify-overrides.ts";

describe("overrideFloor", () => {
  it("floors exact, caret and tilde forms", () => {
    expect(overrideFloor("4.6.5")).toBe("4.6.5");
    expect(overrideFloor("^7.0.107")).toBe("7.0.107");
    expect(overrideFloor("~1.2.3")).toBe("1.2.3");
    expect(overrideFloor("1.0.0-beta.2")).toBe("1.0.0-beta.2");
  });

  it("refuses shapes it cannot floor", () => {
    expect(overrideFloor(">=4")).toBeNull();
    expect(overrideFloor("latest")).toBeNull();
    expect(overrideFloor("npm:zod@4.6.5")).toBeNull();
  });
});

describe("checkOverrides", () => {
  const manifest = (path: string, deps: Record<string, string>) => ({
    path,
    json: { dependencies: deps },
  });

  it("fails an override below a declared floor", () => {
    const problems = checkOverrides({ zod: "4.5.4" }, [
      manifest("packages/core/package.json", { zod: "^4.6.5" }),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("packages/core/package.json dependencies.zod");
  });

  it("passes an override every declared range admits", () => {
    expect(
      checkOverrides({ zod: "4.6.5", ai: "^7.0.107" }, [
        manifest("a/package.json", { zod: "^4.6.5", ai: "^7.0.107" }),
        manifest("b/package.json", { zod: "^4.4.3 || ^3.25" }),
      ]),
    ).toEqual([]);
  });

  it("reads every dependency field, and skips protocol specifiers", () => {
    const problems = checkOverrides({ jose: "6.2.12" }, [
      { path: "x/package.json", json: { peerDependencies: { jose: "^7.0.0" } } },
      manifest("y/package.json", { jose: "workspace:*" }),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("peerDependencies.jose");
  });

  it("reports an override it cannot floor", () => {
    expect(checkOverrides({ zod: ">=4" }, [])[0]).toContain("overrides.zod");
  });
});

describe("the repository", () => {
  it("has no override contradicting a declared range", () => {
    const { overrides, manifests } = loadManifests(join(import.meta.dir, "..", ".."));
    expect(manifests.length).toBeGreaterThan(10);
    expect(checkOverrides(overrides, manifests)).toEqual([]);
  });
});
