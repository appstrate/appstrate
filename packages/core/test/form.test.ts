// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  asJSONSchemaObject,
  getOrderedKeys,
  isFileField,
  isMultipleFileField,
  mapAfpsToRjsf,
  mergeWithDefaults,
  type JSONSchemaObject,
  type SchemaWrapper,
} from "../src/form.ts";

describe("isFileField / isMultipleFileField", () => {
  it("detects a single-file field", () => {
    expect(
      isFileField({ type: "string", format: "uri", contentMediaType: "application/pdf" }),
    ).toBe(true);
    expect(isFileField({ type: "string", format: "uri" })).toBe(false);
    expect(isFileField({ type: "string" })).toBe(false);
  });

  it("detects a multiple-file field", () => {
    const prop = {
      type: "array" as const,
      items: { type: "string" as const, format: "uri", contentMediaType: "image/png" },
    };
    expect(isFileField(prop)).toBe(true);
    expect(isMultipleFileField(prop)).toBe(true);
  });
});

describe("getOrderedKeys", () => {
  const schema: JSONSchemaObject = {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
  };

  it("returns all keys when no order given", () => {
    expect(getOrderedKeys(schema)).toEqual(["a", "b", "c"]);
  });

  it("honors propertyOrder and appends unlisted keys", () => {
    expect(getOrderedKeys(schema, ["c", "a"])).toEqual(["c", "a", "b"]);
  });
});

describe("mergeWithDefaults", () => {
  const schema: JSONSchemaObject = {
    type: "object",
    properties: {
      name: { type: "string", default: "anon" },
      count: { type: "integer" },
    },
  };

  it("fills missing keys with defaults, null otherwise", () => {
    expect(mergeWithDefaults(schema, { count: 3 })).toEqual({ name: "anon", count: 3 });
    expect(mergeWithDefaults(schema, null)).toEqual({ name: "anon", count: null });
  });
});

describe("mapAfpsToRjsf", () => {
  it("passes schema through unchanged", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const { schema: out } = mapAfpsToRjsf({ schema });
    expect(out).toBe(schema);
  });

  it("maps file fields to ui:widget=file with options", () => {
    const wrapper: SchemaWrapper = {
      schema: {
        type: "object",
        properties: {
          doc: { type: "string", format: "uri", contentMediaType: "application/pdf" },
          photos: {
            type: "array",
            items: { type: "string", format: "uri", contentMediaType: "image/*" },
            maxItems: 3,
          },
        },
      },
      fileConstraints: {
        doc: { accept: ".pdf", maxSize: 1_000_000 },
        photos: { accept: "image/*" },
      },
    };
    const { uiSchema } = mapAfpsToRjsf(wrapper);
    expect(uiSchema.doc).toMatchObject({
      "ui:widget": "file",
      "ui:options": { accept: ".pdf", maxSize: 1_000_000 },
    });
    expect(uiSchema.photos).toMatchObject({
      "ui:widget": "file",
      "ui:options": { multiple: true, accept: "image/*", maxFiles: 3 },
    });
  });

  it("maps propertyOrder to ui:order with wildcard", () => {
    const wrapper: SchemaWrapper = {
      schema: {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
      },
      propertyOrder: ["c", "a"],
    };
    const { uiSchema } = mapAfpsToRjsf(wrapper);
    expect(uiSchema["ui:order"]).toEqual(["c", "a", "b", "*"]);
  });

  it("maps long maxLength strings to textarea", () => {
    const wrapper: SchemaWrapper = {
      schema: {
        type: "object",
        properties: {
          bio: { type: "string", maxLength: 2000 },
          title: { type: "string", maxLength: 200 },
        },
      },
      uiHints: { bio: { placeholder: "Tell us…" } },
    };
    const { uiSchema } = mapAfpsToRjsf(wrapper);
    expect(uiSchema.bio).toMatchObject({ "ui:widget": "textarea", "ui:placeholder": "Tell us…" });
    expect(uiSchema.title).toBeUndefined();
  });
});

describe("asJSONSchemaObject", () => {
  it("is an unchecked cast — returns its argument", () => {
    const raw: unknown = { type: "object", properties: {} };
    expect(asJSONSchemaObject(raw)).toEqual(raw as JSONSchemaObject);
  });
});
