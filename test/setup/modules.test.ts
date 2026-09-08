// SPDX-License-Identifier: Apache-2.0

/**
 * The three decisions `test/setup/modules.ts` makes on behalf of two processes
 * that must agree — the preload (import/register/init a module?) and the
 * tier-0 runner (collect its test files?).
 *
 * No module in the repo declares `test/requirements.ts` yet, so nothing here
 * exercises these paths from real state. These assertions are the negative
 * control that absence cannot provide: a rejection that stopped rejecting, or a
 * skip that stopped skipping, would be invisible until the first module relied
 * on it — and would then present as the failure the declaration existed to
 * prevent.
 */

import { describe, it, expect } from "bun:test";
import { discoverModules, envToApply, parseModuleRequirements, skipsInTier } from "./modules.ts";
import { resolve } from "node:path";

const SOURCE = "packages/module-x/test/requirements.ts";

describe("parseModuleRequirements", () => {
  it("accepts an empty object", () => {
    expect(parseModuleRequirements({}, SOURCE)).toEqual({});
  });

  it("accepts both fields", () => {
    expect(parseModuleRequirements({ postgres: true, env: { A: "1" } }, SOURCE)).toEqual({
      postgres: true,
      env: { A: "1" },
    });
  });

  it("rejects a missing default export, naming the file", () => {
    expect(() => parseModuleRequirements(undefined, SOURCE)).toThrow(
      /packages\/module-x\/test\/requirements\.ts must default-export/,
    );
  });

  it("rejects a non-object default export", () => {
    expect(() => parseModuleRequirements(true, SOURCE)).toThrow(/got boolean/);
    expect(() => parseModuleRequirements(null, SOURCE)).toThrow(/got object/);
    expect(() => parseModuleRequirements([], SOURCE)).toThrow(/got an array/);
  });

  it("rejects an unknown key", () => {
    // The failure this rejection exists for: `postgress: true` would parse as a
    // module with no requirements, run under tier 0, and fail on the missing
    // database it had just declared it needed.
    expect(() => parseModuleRequirements({ postgress: true }, SOURCE)).toThrow(
      /unknown requirement `postgress`/,
    );
  });

  it("rejects a non-boolean postgres and a non-string env value", () => {
    expect(() => parseModuleRequirements({ postgres: "yes" }, SOURCE)).toThrow(
      /`postgres` must be a boolean, got string/,
    );
    expect(() => parseModuleRequirements({ env: "A=1" }, SOURCE)).toThrow(
      /`env` must be an object of string values/,
    );
    expect(() => parseModuleRequirements({ env: { A: 1 } }, SOURCE)).toThrow(
      /`env\.A` must be a string, got number/,
    );
  });
});

describe("skipsInTier", () => {
  it("skips a postgres module under tier 0 only", () => {
    expect(skipsInTier({ postgres: true }, true)).toBe(true);
    expect(skipsInTier({ postgres: true }, false)).toBe(false);
  });

  it("never skips a module that declares nothing", () => {
    expect(skipsInTier({}, true)).toBe(false);
    expect(skipsInTier({ postgres: false }, true)).toBe(false);
  });
});

describe("envToApply", () => {
  it("returns the declared entries the environment does not carry", () => {
    expect(envToApply({ env: { A: "1", B: "2" } }, { B: "operator" })).toEqual({ A: "1" });
  });

  it("treats an empty string as set — `??=`, not `||=`", () => {
    expect(envToApply({ env: { A: "1" } }, { A: "" })).toEqual({});
  });

  it("returns nothing when no env is declared", () => {
    expect(envToApply({ postgres: true }, {})).toEqual({});
  });
});

describe("discoverModules", () => {
  it("finds both module roots", () => {
    const dirs = discoverModules(resolve(import.meta.dir, "../..")).map((m) => m.dir);
    expect(dirs.some((d) => d.includes("apps/api/src/modules/"))).toBe(true);
    expect(dirs.some((d) => d.includes("packages/module-"))).toBe(true);
  });

  it("returns an empty list for a root that holds neither", () => {
    expect(discoverModules(resolve(import.meta.dir, "no-such-root"))).toEqual([]);
  });
});
