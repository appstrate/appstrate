// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { readDeclaredOutputSchema } from "../src/output-schema.ts";

describe("readDeclaredOutputSchema", () => {
  it("returns a non-empty `output.schema`", () => {
    const schema = { type: "object", properties: { n: { type: "number" } } };
    expect(readDeclaredOutputSchema({ output: { schema } })).toBe(schema);
  });

  it("returns undefined when no usable schema is declared", () => {
    for (const manifest of [
      undefined,
      {},
      { output: null },
      { output: {} },
      { output: { schema: {} } },
      { output: { schema: [] } },
      { output: { schema: "object" } },
    ]) {
      expect(readDeclaredOutputSchema(manifest)).toBeUndefined();
    }
  });
});
