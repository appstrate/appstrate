// SPDX-License-Identifier: Apache-2.0

/** The discovery both env gates depend on, run against the real tree — elsewhere it is injected. */

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
    expect(typeof ee!.shape.STRIPE_SECRET_KEY!.safeParse).toBe("function");
    expect(ee!.exportName).toContain("eeEnvSchema");
  });

  it("finds every module env.ts structured — none reads process.env by hand", () => {
    expect(discovered.schemas.map((s) => s.id)).toEqual(["chat", "ee", "observability"]);
    expect(Object.keys(discovered.schemas.find((s) => s.id === "chat")!.shape)).toEqual([
      "CHAT_PI_MAX_CONCURRENCY",
      "CHAT_SELF_ORIGIN",
    ]);
    expect(discovered.unstructured).toEqual([]);
  });

  it("returns both halves in id order", () => {
    const ids = discovered.schemas.map((s) => s.id);
    expect(ids).toEqual([...ids].sort());
    const unstructuredIds = discovered.unstructured.map((m) => m.id);
    expect(unstructuredIds).toEqual([...unstructuredIds].sort());
  });
});
