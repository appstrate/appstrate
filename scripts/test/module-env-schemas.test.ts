// SPDX-License-Identifier: Apache-2.0

/**
 * The discovery both env gates depend on, run against the real tree.
 *
 * Every other test of those gates injects `moduleEnv` through their deps, which
 * exercises what they DO with a module schema and nothing about whether one is
 * ever found. A glob that stopped matching, an import that stopped resolving or
 * a `shape` that stopped looking like Zod would leave both gates green over an
 * empty module population — the exact hole the union closed one level up.
 */

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { moduleEnvSchemas } from "../lib/module-env-schemas.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const discovered = await moduleEnvSchemas(REPO_ROOT);

describe("moduleEnvSchemas over this repository", () => {
  it("finds the module that declares a Zod env schema, with its keys", () => {
    const ee = discovered.schemas.find((s) => s.id === "ee");
    expect(ee).toBeDefined();
    expect(ee!.file).toBe("packages/module-ee/src/env.ts");
    expect(Object.keys(ee!.shape)).toContain("STRIPE_SECRET_KEY");
    // A field the gates can ask "does this reject `undefined`?" of.
    expect(typeof ee!.shape.STRIPE_SECRET_KEY!.safeParse).toBe("function");
    expect(ee!.exportName).toContain("eeEnvSchema");
  });

  it("lists a module whose env.ts exports no Zod object as unstructured", () => {
    // `packages/module-observability/src/env.ts` reads `process.env` by hand,
    // so its names cannot be derived and stay hand-documented. Counting it as a
    // schema would claim coverage the gates do not have; dropping it silently
    // would hide that half of the population exists.
    expect(discovered.unstructured.map((m) => m.id)).toContain("observability");
    expect(discovered.unstructured.find((m) => m.id === "observability")!.file).toBe(
      "packages/module-observability/src/env.ts",
    );
    expect(discovered.schemas.map((s) => s.id)).not.toContain("observability");
  });

  it("returns both halves in id order", () => {
    const ids = discovered.schemas.map((s) => s.id);
    expect(ids).toEqual([...ids].sort());
    const unstructuredIds = discovered.unstructured.map((m) => m.id);
    expect(unstructuredIds).toEqual([...unstructuredIds].sort());
  });
});
