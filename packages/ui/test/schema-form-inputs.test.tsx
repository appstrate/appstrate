// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WidgetProps } from "@rjsf/utils";
import { SchemaForm } from "../src/schema-form/index.tsx";
import { SelectWidget } from "../src/schema-form/widgets.tsx";

const browserLanguages = Object.getOwnPropertyDescriptor(globalThis.navigator, "languages");

/** RJSF reads the decimal separator off `navigator.languages`. */
function setBrowserLanguages(languages: string[]): void {
  Object.defineProperty(globalThis.navigator, "languages", {
    value: languages,
    configurable: true,
  });
}

afterEach(() => {
  if (browserLanguages) {
    Object.defineProperty(globalThis.navigator, "languages", browserLanguages);
  } else {
    Reflect.deleteProperty(globalThis.navigator, "languages");
  }
});

/** The open tag of the input RJSF renders for the root property `field`. */
function inputTag(property: Record<string, unknown>): string {
  const html = renderToStaticMarkup(
    <SchemaForm
      wrapper={{ schema: { type: "object", properties: { field: property } } }}
      formData={{}}
    />,
  );
  const tag = /<input\b[^>]*id="root_field"[^>]*>/.exec(html)?.[0];
  expect(tag).toBeDefined();
  return tag!.toLowerCase();
}

describe("SchemaForm inputs", () => {
  it("renders an integer as a numeric input", () => {
    setBrowserLanguages(["en-US"]);
    expect(inputTag({ type: "integer" })).toContain('type="number"');
  });

  it("leaves the schema's bounds to the validator, not to the browser's own bubble", () => {
    setBrowserLanguages(["en-US"]);
    const tag = inputTag({ type: "integer", minimum: 1, maximum: 5, multipleOf: 2 });
    expect(tag).toContain('step="any"');
    expect(tag).not.toContain(" min=");
    expect(tag).not.toContain(" max=");
  });

  it("renders a number as a numeric input where the decimal separator is a dot", () => {
    setBrowserLanguages(["en-US"]);
    const tag = inputTag({ type: "number" });
    expect(tag).toContain('type="number"');
    expect(tag).not.toContain("inputmode");
  });

  it("keeps a number as text under a comma locale, with the decimal keypad", () => {
    setBrowserLanguages(["fr-FR"]);
    const tag = inputTag({ type: "number" });
    expect(tag).toContain('type="text"');
    expect(tag).toContain('inputmode="decimal"');
  });

  it("leaves a string as free text", () => {
    const tag = inputTag({ type: "string" });
    expect(tag).toContain('type="text"');
    expect(tag).not.toContain("inputmode");
    expect(tag).not.toContain("step=");
  });
});

describe("SelectWidget option matching", () => {
  const enumOptions = [
    { label: "Alpha", value: { id: 1 } },
    { label: "Beta", value: { id: 2 } },
  ];
  const render = (value: unknown) =>
    renderToStaticMarkup(
      <SelectWidget
        {...({ id: "s", value, options: { enumOptions } } as unknown as WidgetProps)}
      />,
    );

  it("selects only the object option equal to the value", () => {
    const html = render({ id: 2 });
    expect(html).toContain("Beta");
    expect(html).not.toContain("Alpha");
  });
});
