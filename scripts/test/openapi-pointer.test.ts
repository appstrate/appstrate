// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { resolveRef } from "../lib/openapi-pointer.ts";

describe("resolveRef", () => {
  const spec = {
    components: { schemas: { Run: { type: "object" }, Leaf: "not an object" } },
  };

  it("resolves a local ref to the object it names", () => {
    expect(resolveRef(spec, "#/components/schemas/Run")).toEqual({ type: "object" });
  });

  it("resolves nothing for an external, missing or non-object target", () => {
    expect(resolveRef(spec, "https://example.com/schema.json")).toBeUndefined();
    expect(resolveRef(spec, "#/components/schemas/Missing")).toBeUndefined();
    expect(resolveRef(spec, "#/components/schemas/Leaf")).toBeUndefined();
  });
});
