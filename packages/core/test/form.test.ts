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
  it("preserves schema contents when no adapter-level tweaks apply", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const { schema: out } = mapAfpsToRjsf({ schema });
    expect(out).toEqual(schema);
  });

  it("marks const properties as read-only", () => {
    const wrapper: SchemaWrapper = {
      schema: {
        type: "object",
        properties: {
          platform: { type: "string", const: "appstrate" },
          name: { type: "string" },
        },
      },
    };
    const { uiSchema } = mapAfpsToRjsf(wrapper);
    expect(uiSchema.platform).toMatchObject({ "ui:readonly": true });
    expect(uiSchema.name).toBeUndefined();
  });

  it("maps array-of-enum to multiselect and injects uniqueItems", () => {
    const wrapper: SchemaWrapper = {
      schema: {
        type: "object",
        properties: {
          channels: {
            type: "array",
            items: { type: "string", enum: ["email", "sms", "slack"] },
          },
        },
      },
    };
    const { schema, uiSchema } = mapAfpsToRjsf(wrapper);
    expect(uiSchema.channels).toMatchObject({ "ui:widget": "multiselect" });
    expect(schema.properties.channels.uniqueItems).toBe(true);
  });

  it("preserves existing uniqueItems on array-of-enum", () => {
    const wrapper: SchemaWrapper = {
      schema: {
        type: "object",
        properties: {
          tags: {
            type: "array",
            uniqueItems: false,
            items: { type: "string", enum: ["a", "b"] },
          },
        },
      },
    };
    const { schema } = mapAfpsToRjsf(wrapper);
    // Falsy uniqueItems still triggers injection (the manifest author almost
    // certainly wants the multi-select UX).
    expect(schema.properties.tags?.uniqueItems).toBe(true);
  });

  it("does not mutate the input schema", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string", enum: ["a", "b"] },
        },
      },
    };
    mapAfpsToRjsf({ schema });
    expect(schema.properties.tags?.uniqueItems).toBeUndefined();
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
