// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  isFileField as sharedIsFileField,
  isMultipleFileField as sharedIsMultipleFileField,
} from "@appstrate/afps-shared/file-field";
import {
  asJSONSchemaObject,
  getOrderedKeys,
  isFileField,
  isMultipleFileField,
  mapAfpsToRjsf,
  authorDefaults,
  type JSONSchema7,
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

  // The two predicates used to be two implementations: `isFileField`
  // delegated to `@appstrate/afps-shared` ("`contentMediaType` DECLARED"),
  // `isMultipleFileField` kept a local copy testing `!!items.contentMediaType`.
  // An empty-string media type is the input that separates them, and it made
  // the pair answer opposite things about ONE node — so `mapAfpsToRjsf` marked
  // an array property `ui:widget: "file"` without `multiple`, i.e. a
  // single-file picker bound to an array.
  it("agrees with isFileField on an array whose items declare an EMPTY contentMediaType", () => {
    const prop = {
      type: "array" as const,
      items: { type: "string" as const, format: "uri", contentMediaType: "" },
    };
    expect(isFileField(prop)).toBe(true);
    expect(isMultipleFileField(prop)).toBe(true);

    const { uiSchema } = mapAfpsToRjsf({
      schema: { type: "object", properties: { docs: prop } },
    });
    expect(uiSchema.docs).toMatchObject({ "ui:widget": "file", "ui:options": { multiple: true } });
  });

  // Control: the two must also agree the OTHER way. An array of plain URIs
  // declares no `contentMediaType` at all, so neither predicate may fire —
  // without this half the assertion above passes for a predicate that
  // returned `true` unconditionally.
  it("agrees with isFileField on an array of plain URIs (no contentMediaType)", () => {
    const prop = {
      type: "array" as const,
      items: { type: "string" as const, format: "uri" },
    };
    expect(isFileField(prop)).toBe(false);
    expect(isMultipleFileField(prop)).toBe(false);

    const { uiSchema } = mapAfpsToRjsf({
      schema: { type: "object", properties: { links: prop } },
    });
    expect(uiSchema.links).toBeUndefined();
  });
});

// `@appstrate/core/form` carries its own copy of the AFPS file-field rule
// instead of importing `@appstrate/afps-shared/file-field`, because core ships
// as SOURCE to npm: a consumer's `tsc` compiles core's files against the
// `@appstrate/afps-shared` THEIR install resolves. Core's declared floor is
// `^0.7.0` and `0.7.0` — the first release to export `isMultipleFileField`
// from that subpath — is not published yet, so the import is unresolvable for
// a consumer today. See the block comment above `isFileField` in
// `../src/form.ts` for the full reasoning and for what would let the two
// merge.
//
// This is the thing that keeps the parallel copies honest. The import below
// resolves to LOCAL workspace source (tests are not part of the published
// `files` list, so nothing here reaches a consumer), so editing one side and
// not the other fails here at dev time — the drift that produced the
// `contentMediaType: ""` bug is exactly what this table would have caught.
describe("file-field rule parity with @appstrate/afps-shared", () => {
  const nodes: Array<[string, unknown]> = [
    ["single file", { type: "string", format: "uri", contentMediaType: "application/pdf" }],
    ["single file, EMPTY media type", { type: "string", format: "uri", contentMediaType: "" }],
    ["uri without contentMediaType", { type: "string", format: "uri" }],
    ["plain string", { type: "string" }],
    [
      "array of files",
      { type: "array", items: { type: "string", format: "uri", contentMediaType: "image/png" } },
    ],
    [
      "array of files, EMPTY media type",
      { type: "array", items: { type: "string", format: "uri", contentMediaType: "" } },
    ],
    ["array of plain URIs", { type: "array", items: { type: "string", format: "uri" } }],
    ["array with items: false", { type: "array", items: false }],
    [
      "tuple items, first is a file",
      { type: "array", items: [{ format: "uri", contentMediaType: "text/csv" }] },
    ],
    [
      "union type, array first",
      {
        type: ["array", "null"],
        items: { type: "string", format: "uri", contentMediaType: "image/png" },
      },
    ],
    // Impossible under `JSONSchema7`, reachable through `asJSONSchemaObject`
    // casts of JSONB columns and dynamic manifests — which is why both rules
    // read the node structurally rather than trusting the declared type.
    ["contentMediaType: false", { format: "uri", contentMediaType: false }],
    ["not an object", "nope"],
    ["null", null],
  ];

  for (const [label, node] of nodes) {
    it(`agrees on: ${label}`, () => {
      expect(isFileField(node as JSONSchema7)).toBe(sharedIsFileField(node));
      expect(isMultipleFileField(node as JSONSchema7)).toBe(sharedIsMultipleFileField(node));
    });
  }

  // Control: the table must contain both answers, or "agrees" would hold for a
  // pair of predicates that always returned the same constant.
  it("covers both answers", () => {
    const answers = nodes.map(([, node]) => sharedIsFileField(node));
    expect(answers).toContain(true);
    expect(answers).toContain(false);
    const multiple = nodes.map(([, node]) => sharedIsMultipleFileField(node));
    expect(multiple).toContain(true);
    expect(multiple).toContain(false);
  });

  // `@appstrate/afps-shared` is PUBLISHED, so every name this subpath exports
  // is a semver commitment to out-of-tree consumers — taking one back later is
  // a breaking release. Its three internal helpers (`isSingleFileNode`,
  // `resolveItems`, `resolveType`) are shared implementation detail of the two
  // predicates above and have no importer anywhere in this repo; exporting
  // them would promise a surface nobody asked for, on a module whose own
  // header argues that core must NOT import them. Pinned here rather than in
  // `packages/afps-shared/test/` because this is the file that already owns
  // the relationship between the two copies of this rule.
  it("exports the two predicates and nothing else", async () => {
    const surface = Object.keys(await import("@appstrate/afps-shared/file-field")).sort();
    expect(surface).toEqual(["isFileField", "isMultipleFileField"]);
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

  it("honors property_order and appends unlisted keys", () => {
    expect(getOrderedKeys(schema, ["c", "a"])).toEqual(["c", "a", "b"]);
  });
});

describe("authorDefaults", () => {
  const schema: JSONSchemaObject = {
    type: "object",
    properties: {
      name: { type: "string", default: "anon" },
      count: { type: "integer" },
      enabled: { type: "boolean", default: false },
      tags: { type: "array", default: [] },
      note: { type: "string", default: "" },
      explicit_null: { type: "string", default: null },
    },
    required: ["count"],
  };

  it("returns only the properties that declare a `default`", () => {
    expect(authorDefaults(schema)).toEqual({
      name: "anon",
      enabled: false,
      tags: [],
      note: "",
      explicit_null: null,
    });
  });

  it("leaves a property without a `default` absent rather than null", () => {
    expect("count" in authorDefaults(schema)).toBe(false);
  });

  it("returns an empty object for an absent schema", () => {
    expect(authorDefaults(undefined)).toEqual({});
  });

  it("returns an empty object for a schema with no properties", () => {
    expect(authorDefaults({ type: "object", properties: {} })).toEqual({});
  });

  it("does not read `default` from anything but a top-level property", () => {
    const nested: JSONSchemaObject = {
      type: "object",
      properties: {
        outer: { type: "object", properties: { inner: { type: "string", default: "deep" } } },
      },
    };
    expect(authorDefaults(nested)).toEqual({});
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
    expect(schema.properties.channels?.uniqueItems).toBe(true);
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
      file_constraints: {
        doc: { accept: ".pdf", max_size: 1_000_000 },
        photos: { accept: "image/*" },
      },
    };
    const { uiSchema } = mapAfpsToRjsf(wrapper);
    expect(uiSchema.doc).toMatchObject({
      "ui:widget": "file",
      // RJSF widget option name (`maxSize`) is camelCase — widget API,
      // not AFPS manifest field.
      "ui:options": { accept: ".pdf", maxSize: 1_000_000 },
    });
    expect(uiSchema.photos).toMatchObject({
      "ui:widget": "file",
      "ui:options": { multiple: true, accept: "image/*", maxFiles: 3 },
    });
  });

  it("maps property_order to ui:order with wildcard", () => {
    const wrapper: SchemaWrapper = {
      schema: {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
      },
      property_order: ["c", "a"],
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
      ui_hints: { bio: { placeholder: "Tell us…" } },
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
