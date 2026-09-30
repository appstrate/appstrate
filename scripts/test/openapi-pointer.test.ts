// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { resolveRef } from "../lib/openapi-pointer.ts";

describe("resolveRef", () => {
  const spec = {
    paths: { "/runs/{id}": { get: { summary: "one run" } } },
    components: { schemas: { "a~b": { type: "string" }, Leaf: "not an object" } },
  };

  it("decodes ~1 and ~0 in each segment", () => {
    expect(resolveRef(spec, "#/paths/~1runs~1{id}/get")).toEqual({ summary: "one run" });
    expect(resolveRef(spec, "#/components/schemas/a~0b")).toEqual({ type: "string" });
  });

  it("resolves nothing for an external, missing or non-object target", () => {
    expect(resolveRef(spec, "https://example.com/schema.json")).toBeUndefined();
    expect(resolveRef(spec, "#/components/schemas/Missing")).toBeUndefined();
    expect(resolveRef(spec, "#/components/schemas/Leaf")).toBeUndefined();
  });
});
