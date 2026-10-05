// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FieldTemplateProps } from "@rjsf/utils";
import { SchemaForm } from "../src/schema-form/index.tsx";
import { FieldTemplate } from "../src/schema-form/templates.tsx";

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

describe("FieldTemplate", () => {
  it("shows the errors of a hidden field, named after it", () => {
    // The summary list is off, so a hidden field has nowhere else to say it.
    const props = {
      id: "root_token",
      label: "token",
      hidden: true,
      rawErrors: ["must be string"],
      schema: { type: "string" },
      children: <input id="root_token" />,
    } as unknown as FieldTemplateProps;
    const html = renderToStaticMarkup(<FieldTemplate {...props} />);
    expect(html).toContain("token: must be string");
    expect(html).toContain('<div class="hidden"><input id="root_token"/></div>');
  });
});
