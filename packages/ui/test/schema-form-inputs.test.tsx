// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SchemaForm } from "../src/schema-form/index.tsx";

/** The open tag of the input RJSF renders for the root property `key`. */
function inputTag(type: "integer" | "number" | "string", key = "field"): string {
  const html = renderToStaticMarkup(
    <SchemaForm
      wrapper={{ schema: { type: "object", properties: { [key]: { type, minimum: 0 } } } }}
      formData={{}}
    />,
  );
  const tag = new RegExp(`<input\\b[^>]*id="root_${key}"[^>]*>`).exec(html)?.[0];
  expect(tag).toBeDefined();
  return tag!;
}

describe("SchemaForm inputs", () => {
  it("renders an integer as a numeric input carrying the schema's bounds", () => {
    const tag = inputTag("integer");
    expect(tag).toContain('type="number"');
    expect(tag).toContain('step="1"');
    expect(tag).toContain('min="0"');
  });

  it("asks for a numeric keyboard for a number, whatever input the locale gets", () => {
    const tag = inputTag("number");
    expect(/type="number"|inputMode="decimal"|inputmode="decimal"/.test(tag)).toBe(true);
  });

  it("leaves a string as free text", () => {
    const tag = inputTag("string");
    expect(tag).toContain('type="text"');
    expect(tag).not.toContain("inputmode");
  });
});
