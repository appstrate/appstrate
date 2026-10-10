// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  caretRange,
  defaultEditorState,
  defaultIntegrationManifest,
  defaultSkillManifest,
  getManifestName,
  getResourceEntries,
  setResourceEntries,
  schemaToFields,
  fieldsToSchema,
  changeType,
  fieldType,
  fileKind,
  itemsEnumText,
  listToText,
  setFileKind,
  setItemsEnum,
  setKeyword,
  textToList,
  textToValue,
  toNumber,
  valueToText,
  manifestToSchemaFields,
  manifestToMetadata,
  metadataToManifestPatch,
  getRuntimeTools,
  withNormalizedManifest,
  setRuntimeTools,
} from "../utils";
import type { SchemaField } from "../schema-section";
import type { JSONSchema7, JSONSchemaObject } from "@appstrate/core/form";
import { AFPS_SCHEMA_VERSION } from "@appstrate/core/validation";
import { parseManifestIntegrations, writeManifestIntegrations } from "@appstrate/core/dependencies";

// ─── getManifestName ────────────────────────────────────────

describe("getManifestName", () => {
  it("parses scoped name", () => {
    expect(getManifestName({ name: "@my-org/my-agent" })).toEqual({
      scope: "my-org",
      id: "my-agent",
    });
  });

  it("returns empty scope for unscoped name", () => {
    expect(getManifestName({ name: "my-agent" })).toEqual({ scope: "", id: "my-agent" });
  });

  it("handles missing name", () => {
    expect(getManifestName({})).toEqual({ scope: "", id: "" });
  });
});

// ─── Resource entries ───────────────────────────────────────

describe("getResourceEntries / setResourceEntries", () => {
  it("reads skills from manifest", () => {
    const m = { dependencies: { skills: { "@org/research": "1.0.0" } } };
    expect(getResourceEntries(m, "skills")).toEqual([{ id: "@org/research", version: "1.0.0" }]);
  });

  it("returns empty array when no deps", () => {
    const m = { dependencies: {} };
    expect(getResourceEntries(m, "skills")).toEqual([]);
  });

  it("roundtrips through set/get", () => {
    const m: Record<string, unknown> = { dependencies: {} };
    setResourceEntries(m, "skills", [
      { id: "@org/a", version: "1.0.0" },
      { id: "@org/b", version: "2.0.0" },
    ]);
    expect(getResourceEntries(m, "skills")).toEqual([
      { id: "@org/a", version: "1.0.0" },
      { id: "@org/b", version: "2.0.0" },
    ]);
  });

  it("removes key when empty", () => {
    const m: Record<string, unknown> = {
      dependencies: { skills: { "@org/a": "1.0.0" } },
    };
    setResourceEntries(m, "skills", []);
    expect((m.dependencies as Record<string, unknown>).skills).toBeUndefined();
  });

  // Niveau 2 — version + tool/scope selection both live on the canonical
  // `dependencies.integrations.<id>` object form (§4.1).
  describe("integrations (deps + integrations_configuration, §4.1/§4.4)", () => {
    it("reads version from deps with no configuration entry", () => {
      const m = { dependencies: { integrations: { "@vendor/gmail": "^1.0.0" } } };
      expect(getResourceEntries(m, "integrations")).toEqual([
        { id: "@vendor/gmail", version: "^1.0.0" },
      ]);
    });

    it("reads version from deps + selection from integrations_configuration", () => {
      const m = {
        dependencies: {
          integrations: { "@vendor/gmail": "^1.0.0" },
        },
        integrations_configuration: {
          "@vendor/gmail": {
            tools: ["list_messages", "send_message"],
            scopes: ["delete"],
          },
        },
      };
      expect(getResourceEntries(m, "integrations")).toEqual([
        {
          id: "@vendor/gmail",
          version: "^1.0.0",
          tools: ["list_messages", "send_message"],
          scopes: ["delete"],
        },
      ]);
    });

    it("writes only the dep map when no tools/scopes are set", () => {
      const m: Record<string, unknown> = { dependencies: {} };
      setResourceEntries(m, "integrations", [{ id: "@vendor/gmail", version: "^1.0.0" }]);
      expect((m.dependencies as Record<string, unknown>).integrations).toEqual({
        "@vendor/gmail": "^1.0.0",
      });
      expect(m.integrations).toBeUndefined();
    });

    it("writes config to integrations_configuration when tools is an explicit array (even empty)", () => {
      // AFPS §4.4 — dep value is a bare semver string; tools/scopes live in
      // the top-level `integrations_configuration` map.
      const m: Record<string, unknown> = { dependencies: {} };
      setResourceEntries(m, "integrations", [
        { id: "@vendor/gmail", version: "^1.0.0", tools: [] },
      ]);
      expect((m.dependencies as Record<string, unknown>).integrations).toEqual({
        "@vendor/gmail": "^1.0.0",
      });
      expect(m.integrations_configuration).toEqual({
        "@vendor/gmail": { tools: [] },
      });
      expect(m.integrations).toBeUndefined();
    });

    it("writes tools + scopes to integrations_configuration (§4.4)", () => {
      const m: Record<string, unknown> = { dependencies: {} };
      setResourceEntries(m, "integrations", [
        { id: "@vendor/gmail", version: "^1.0.0", tools: ["list_messages"], scopes: ["delete"] },
      ]);
      expect((m.dependencies as Record<string, unknown>).integrations).toEqual({
        "@vendor/gmail": "^1.0.0",
      });
      expect(m.integrations_configuration).toEqual({
        "@vendor/gmail": {
          tools: ["list_messages"],
          scopes: ["delete"],
        },
      });
      expect(m.integrations).toBeUndefined();
    });

    it("round-trips a mix of selection-less + selected entries", () => {
      const m: Record<string, unknown> = { dependencies: {} };
      setResourceEntries(m, "integrations", [
        { id: "@vendor/none", version: "^1.0.0" },
        { id: "@vendor/picked", version: "^2.0.0", tools: ["read"] },
      ]);
      const back = getResourceEntries(m, "integrations");
      expect(back).toEqual([
        { id: "@vendor/none", version: "^1.0.0" },
        { id: "@vendor/picked", version: "^2.0.0", tools: ["read"] },
      ]);
    });

    // AFPS §4.4 wildcard — the `"*"` literal MUST round-trip verbatim
    // through getResourceEntries / setResourceEntries; spreading it (which a
    // naive `[...e.tools]` would do, since strings are iterable) corrupts the
    // wildcard to `["*"]` and breaks the runtime opt-in.
    it('getResourceEntries preserves the wildcard literal `"*"` on tools', () => {
      const m = {
        dependencies: { integrations: { "@vendor/github-mcp": "^1.0.0" } },
        integrations_configuration: { "@vendor/github-mcp": { tools: "*" } },
      };
      expect(getResourceEntries(m, "integrations")).toEqual([
        { id: "@vendor/github-mcp", version: "^1.0.0", tools: "*" },
      ]);
    });

    it('setResourceEntries writes the wildcard literal verbatim (not as `["*"]`)', () => {
      const m: Record<string, unknown> = { dependencies: {} };
      setResourceEntries(m, "integrations", [
        { id: "@vendor/github-mcp", version: "^1.0.0", tools: "*" },
      ]);
      const config = m.integrations_configuration as Record<string, { tools?: unknown }>;
      expect(config["@vendor/github-mcp"]!.tools).toBe("*");
    });

    it("keeps `required` and `_meta` through an editor get → set round trip", () => {
      const m: Record<string, unknown> = {
        dependencies: { integrations: { "@vendor/gmail": "^1.0.0" } },
        integrations_configuration: {
          "@vendor/gmail": {
            tools: ["list_messages"],
            required: true,
            _meta: { "dev.vendor/x": { a: 1 } },
          },
        },
      };
      setResourceEntries(m, "integrations", getResourceEntries(m, "integrations"));
      expect(m.integrations_configuration).toEqual({
        "@vendor/gmail": {
          tools: ["list_messages"],
          required: true,
          _meta: { "dev.vendor/x": { a: 1 } },
        },
      });
    });

    // A key the core models next must not need an editor change to survive a save.
    it("hands the core's integration entries through whole, both ways", () => {
      const m: Record<string, unknown> = {
        dependencies: { integrations: { "@vendor/gmail": "^1.0.0" } },
        integrations_configuration: {
          "@vendor/gmail": { tools: ["a"], scopes: ["s"], auth_key: "oauth", required: true },
        },
      };
      const entries = getResourceEntries(m, "integrations");
      expect(entries).toStrictEqual(parseManifestIntegrations(m));

      const viaEditor: Record<string, unknown> = { dependencies: {} };
      const viaCore: Record<string, unknown> = { dependencies: {} };
      setResourceEntries(viaEditor, "integrations", entries);
      writeManifestIntegrations(viaCore, parseManifestIntegrations(m));
      expect(viaEditor).toStrictEqual(viaCore);
    });

    it("round-trips the wildcard tools literal through set → get", () => {
      const m: Record<string, unknown> = { dependencies: {} };
      setResourceEntries(m, "integrations", [
        { id: "@vendor/github-mcp", version: "^1.0.0", tools: "*", auth_key: "oauth" },
      ]);
      expect(getResourceEntries(m, "integrations")).toEqual([
        { id: "@vendor/github-mcp", version: "^1.0.0", tools: "*", auth_key: "oauth" },
      ]);
    });
  });
});

// ─── defaultEditorState ─────────────────────────────────────

describe("defaultEditorState", () => {
  it("returns valid manifest structure", () => {
    const state = defaultEditorState("my-org", "user@test.com");
    expect(state.manifest.name).toBe("@my-org/");
    expect(state.manifest.author).toBe("user@test.com");
    expect(state.manifest.type).toBe("agent");
    expect(state.manifest.version).toBe("1.0.0");
    expect(state.manifest.schema_version).toBe(AFPS_SCHEMA_VERSION);
    expect(state.manifest.schemaVersion).toBeUndefined();
    expect(state.operations).toEqual([{ op: "write", path: "prompt.md", text: "" }]);
  });

  it("skill and integration defaults declare the same schema_version", () => {
    expect(defaultSkillManifest("my-org").schema_version).toBe(AFPS_SCHEMA_VERSION);
    expect(defaultIntegrationManifest("my-org").schema_version).toBe(AFPS_SCHEMA_VERSION);
  });

  it("handles missing org slug", () => {
    const state = defaultEditorState();
    expect(state.manifest.name).toBe("");
  });
});

// ─── caretRange ─────────────────────────────────────────────

describe("caretRange", () => {
  it("prefixes a version with `^`", () => {
    expect(caretRange("1.2.3")).toBe("^1.2.3");
    expect(caretRange("0.0.1")).toBe("^0.0.1");
  });
});

// ─── Schema fields ──────────────────────────────────────────

const FILE_ITEM = {
  type: "string",
  format: "uri",
  contentMediaType: "application/octet-stream",
} as const;

const fieldOf = (
  key: string,
  prop: JSONSchema7,
  extra: Partial<SchemaField> = {},
): SchemaField => ({
  _id: key,
  key,
  required: false,
  prop,
  ...extra,
});

describe("schemaToFields / fieldsToSchema", () => {
  it("roundtrips output schema", () => {
    const schema = {
      type: "object",
      properties: {
        summary: { type: "string", description: "Brief summary" },
        count: { type: "number", description: "Total count" },
      },
      required: ["summary"],
    } satisfies JSONSchemaObject;
    const fields = schemaToFields(schema, "output", { property_order: ["summary", "count"] });
    expect(fields).toHaveLength(2);
    expect(fields[0]!.key).toBe("summary");
    expect(fields[0]!.required).toBe(true);
    expect(fields[1]!.key).toBe("count");
    expect(fields[1]!.required).toBe(false);
    expect(fieldsToSchema(fields, "output")!.schema).toEqual(schema);
  });

  it("returns null for empty fields and [] for an undefined schema", () => {
    expect(fieldsToSchema([], "output")).toBeNull();
    expect(schemaToFields(undefined, "output")).toEqual([]);
  });

  it("does not persist fields with an empty key", () => {
    const result = fieldsToSchema([fieldOf("a", { type: "string" }), fieldOf(" ", {})], "input");
    expect(Object.keys(result!.schema.properties)).toEqual(["a"]);
    expect(result!.property_order).toEqual(["a"]);
  });

  it("keeps the prop as the field state (no copy projection)", () => {
    const prop: JSONSchema7 = { type: "string", minLength: 3 };
    const fields = schemaToFields({ type: "object", properties: { a: prop } }, "input");
    expect(fields[0]!.prop).toBe(prop);
  });

  it("reads placeholder from ui_hints and writes it back there", () => {
    const schema: JSONSchemaObject = { type: "object", properties: { query: { type: "string" } } };
    const fields = schemaToFields(schema, "input", {
      ui_hints: { query: { placeholder: "Enter query..." } },
      property_order: ["query"],
    });
    expect(fields[0]!.placeholder).toBe("Enter query...");
    const result = fieldsToSchema(fields, "input")!;
    expect(result.ui_hints?.query?.placeholder).toBe("Enter query...");
    expect(result.schema.properties.query).not.toHaveProperty("placeholder");
  });

  it("reads file constraints for file fields and writes them back to file_constraints", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: {
        doc: { type: "array", items: { ...FILE_ITEM }, maxItems: 5, description: "Upload docs" },
      },
    };
    const fields = schemaToFields(schema, "input", {
      file_constraints: { doc: { accept: ".pdf", max_size: 10485760 } },
      property_order: ["doc"],
    });
    expect(fields[0]!.accept).toBe(".pdf");
    expect(fields[0]!.maxSize).toBe(10485760);
    expect(fieldType(fields[0]!.prop, "input")).toBe("string");
    expect(fileKind(fields[0]!.prop, "input")).toBe("multiple");

    const result = fieldsToSchema(fields, "input")!;
    expect(result.schema).toEqual(schema);
    expect(result.file_constraints?.doc).toEqual({ accept: ".pdf", max_size: 10485760 });
    expect(result.schema.properties.doc).not.toHaveProperty("accept");
    expect(result.schema.properties.doc).not.toHaveProperty("maxSize");
  });

  it("only emits constraints for file fields and hints for non-file fields", () => {
    const result = fieldsToSchema(
      [
        fieldOf("q", { type: "string" }, { accept: ".pdf", maxSize: 1, placeholder: "type…" }),
        fieldOf("doc", { ...FILE_ITEM }, { accept: ".pdf", placeholder: "ignored" }),
      ],
      "input",
    )!;
    expect(result.ui_hints).toEqual({ q: { placeholder: "type…" } });
    expect(result.file_constraints).toEqual({ doc: { accept: ".pdf" } });
  });

  it("treats a file-shaped property as a plain property in output mode", () => {
    const schema: JSONSchemaObject = { type: "object", properties: { doc: { ...FILE_ITEM } } };
    const fields = schemaToFields(schema, "output", { file_constraints: { doc: { accept: "x" } } });
    expect(fileKind(fields[0]!.prop, "output")).toBe("none");
    expect(fieldsToSchema(fields, "output")).toEqual({
      schema,
      property_order: ["doc"],
    });
  });

  it("wrapper output has only canonical snake_case keys and no property_order in the schema", () => {
    const wrapper = fieldsToSchema(
      [
        fieldOf("doc", { ...FILE_ITEM }, { accept: ".pdf", maxSize: 10485760 }),
        fieldOf("q", { type: "string" }, { placeholder: "type…" }),
      ],
      "input",
    )!;
    expect(wrapper).toHaveProperty("file_constraints");
    expect(wrapper).toHaveProperty("ui_hints");
    expect(wrapper.property_order).toEqual(["doc", "q"]);
    for (const key of ["fileConstraints", "uiHints", "propertyOrder"]) {
      expect(wrapper).not.toHaveProperty(key);
    }
    expect(wrapper.schema).not.toHaveProperty("property_order");
    expect(wrapper.file_constraints!.doc).toHaveProperty("max_size");
    expect(wrapper.file_constraints!.doc).not.toHaveProperty("maxSize");
    expect(JSON.stringify(wrapper.schema)).not.toContain('"file"');
  });

  it("replacing the wrapper wholesale drops non-canonical camelCase keys", () => {
    const manifest: Record<string, unknown> = {
      input: {
        schema: { type: "object", properties: { x: { type: "string" } } },
        fileConstraints: { x: { accept: ".pdf", maxSize: 1000 } },
        uiHints: { x: { placeholder: "old" } },
        propertyOrder: ["x"],
      },
    };
    manifest.input = fieldsToSchema(
      [fieldOf("x", { type: "string" }, { placeholder: "new" })],
      "input",
    );
    const input = JSON.parse(JSON.stringify(manifest)).input as Record<string, unknown>;
    expect(input).not.toHaveProperty("fileConstraints");
    expect(input).not.toHaveProperty("uiHints");
    expect(input).not.toHaveProperty("propertyOrder");
    expect(input).toHaveProperty("ui_hints");
    expect(input).toHaveProperty("property_order");
  });

  it("reads canonical snake_case wrappers from the manifest, honouring property_order", () => {
    const manifest: Record<string, unknown> = {
      input: {
        schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search" },
            doc: { ...FILE_ITEM, description: "Upload" },
          },
          required: ["query"],
        },
        ui_hints: { query: { placeholder: "type…" } },
        file_constraints: { doc: { accept: ".pdf", max_size: 1_000_000 } },
        property_order: ["doc", "query"],
      },
    };
    const input = manifestToSchemaFields(manifest).input!;
    expect(input.map((f) => f.key)).toEqual(["doc", "query"]);
    expect(input.find((f) => f.key === "query")!.placeholder).toBe("type…");
    const doc = input.find((f) => f.key === "doc")!;
    expect(fileKind(doc.prop, "input")).toBe("single");
    expect(doc.accept).toBe(".pdf");
    expect(doc.maxSize).toBe(1_000_000);
  });

  it("recomputes root required from the flags, and omits it when none", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a", "b"],
    };
    const fields = schemaToFields(schema, "input");
    fields[0] = { ...fields[0]!, required: false };
    expect(fieldsToSchema(fields, "input", schema)!.schema.required).toEqual(["b"]);
    fields[1] = { ...fields[1]!, required: false };
    expect("required" in fieldsToSchema(fields, "input", schema)!.schema).toBe(false);
  });
});

// ─── Lossless round-trip (#1896) ────────────────────────────

describe("schemaToFields / fieldsToSchema — lossless round-trip", () => {
  const FILE_PDF = { type: "string", format: "uri", contentMediaType: "application/pdf" } as const;
  const cases: Record<string, JSONSchemaObject["properties"]> = {
    "nested object properties, required and additionalProperties": {
      address: {
        type: "object",
        description: "Where",
        properties: { city: { type: "string" }, zip: { type: "integer", minimum: 0 } },
        required: ["city"],
        additionalProperties: false,
      },
    },
    "array of objects": {
      rows: {
        type: "array",
        items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        minItems: 1,
      },
    },
    "array of integers with item constraints": {
      ids: { type: "array", items: { type: "integer", minimum: 0 } },
    },
    "numeric enum": { level: { type: "integer", enum: [1, 2, 3], default: 2 } },
    "boolean enum": { flag: { type: "boolean", enum: [true, false] } },
    "object default": { cfg: { type: "object", default: { a: 1 } } },
    "array default": { tags: { type: "array", default: ["x", "y"] } },
    "enum with a comma value": { city: { type: "string", enum: ["Paris, FR", "Lyon"] } },
    "non-primitive items.enum": { pick: { type: "array", items: { enum: [{ a: 1 }, { a: 2 }] } } },
    "unknown keywords": {
      a: { type: "string", title: "A", examples: ["x"] },
      b: { oneOf: [{ type: "string" }, { type: "number" }], title: "B" },
      c: { type: ["string", "null"], const: null },
      d: { type: "number", format: "double" },
    },
    "union types, items unions included": {
      n: { type: ["integer", "null"] },
      pick: { type: "array", items: { type: ["string", "null"], enum: ["a", "b"] } },
    },
    $ref: { a: { $ref: "#/$defs/x" } },
    "single file with contentMediaType and title": {
      doc: { ...FILE_PDF, title: "Doc" },
    },
    "multiple files with minItems and item keywords": {
      docs: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: { ...FILE_PDF, title: "Page" },
      },
    },
  };

  for (const [name, properties] of Object.entries(cases)) {
    for (const mode of ["input", "output"] as const) {
      it(`${name} (${mode})`, () => {
        const schema: JSONSchemaObject = { type: "object", properties };
        const result = fieldsToSchema(schemaToFields(schema, mode), mode, schema)!.schema;
        expect(result).toEqual(schema);
      });
    }
  }

  it("keeps root keys ($defs, additionalProperties, title) and required", () => {
    const schema: JSONSchemaObject & Record<string, unknown> = {
      type: "object",
      title: "Root",
      additionalProperties: false,
      $defs: { x: { type: "string" } },
      properties: { a: { $ref: "#/$defs/x" }, b: { type: "string" } },
      required: ["b"],
    };
    expect(fieldsToSchema(schemaToFields(schema, "input"), "input", schema)!.schema).toEqual(
      schema,
    );
  });

  it("a description edit on one field leaves the others byte-identical", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: {
        name: { type: "string", description: "old" },
        address: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          title: "Address",
        },
        pick: { type: "array", items: { type: ["string", "null"], enum: ["a"] } },
      },
    };
    const before = JSON.stringify(schema.properties);
    const fields = schemaToFields(schema, "input");
    fields[0] = { ...fields[0]!, prop: setKeyword(fields[0]!.prop, "description", "new") };
    const out = fieldsToSchema(fields, "input")!.schema.properties;
    expect(out.name!.description).toBe("new");
    expect(JSON.stringify({ ...out, name: schema.properties.name })).toBe(before);
  });
});

// ─── Keyword operations ─────────────────────────────────────

describe("setKeyword", () => {
  it("sets a keyword without mutating the input", () => {
    const prop: JSONSchema7 = { type: "string" };
    expect(setKeyword(prop, "minLength", 2)).toEqual({ type: "string", minLength: 2 });
    expect(prop).toEqual({ type: "string" });
  });

  it("deletes the keyword on undefined", () => {
    const next = setKeyword({ type: "string", minLength: 2 }, "minLength", undefined);
    expect(next).toEqual({ type: "string" });
    expect("minLength" in next).toBe(false);
  });

  it("never rewrites a union type", () => {
    const next = setKeyword({ type: ["integer", "null"] }, "default", 5);
    expect(next).toEqual({ type: ["integer", "null"], default: 5 });
  });
});

describe("changeType", () => {
  it("drops the old type's keywords and keeps the description", () => {
    const prop: JSONSchema7 = {
      type: "object",
      description: "d",
      properties: { a: { type: "string" } },
      default: { a: "x" },
    };
    expect(changeType(prop, "string")).toEqual({ type: "string", description: "d" });
  });

  it("does not add an undefined description", () => {
    expect(changeType({ type: "array", items: {} }, "number")).toEqual({ type: "number" });
  });
});

describe("setFileKind", () => {
  it("turns a plain property into a single file, keeping the description", () => {
    expect(setFileKind({ type: "string", description: "d", minLength: 1 }, "single")).toEqual({
      ...FILE_ITEM,
      description: "d",
    });
  });

  it("turns a single file into multiple files", () => {
    const next = setFileKind({ ...FILE_ITEM, description: "d" }, "multiple");
    expect(next).toEqual({ type: "array", items: { ...FILE_ITEM }, description: "d" });
    expect(fileKind(next, "input")).toBe("multiple");
  });

  it("turns files off into a plain string", () => {
    expect(
      setFileKind({ type: "array", items: { ...FILE_ITEM }, description: "d" }, "none"),
    ).toEqual({
      type: "string",
      description: "d",
    });
    expect(setFileKind({ ...FILE_ITEM }, "none")).toEqual({ type: "string" });
  });

  it("file fields exist in input mode only, and show as strings", () => {
    expect(fileKind({ ...FILE_ITEM }, "output")).toBe("none");
    expect(fieldType({ type: "array", items: { ...FILE_ITEM } }, "input")).toBe("string");
    expect(fieldType({ type: "array", items: { type: "string" } }, "input")).toBe("array");
    expect(fieldType({ type: ["integer", "null"] }, "input")).toBe("integer");
    expect(fieldType({ oneOf: [] }, "input")).toBe("string");
  });
});

describe("setItemsEnum", () => {
  it("keeps the other items keywords and the items type", () => {
    const prop: JSONSchema7 = { type: "array", items: { type: ["string", "null"], title: "T" } };
    expect(setItemsEnum(prop, ["a", "b"])).toEqual({
      type: "array",
      items: { type: ["string", "null"], title: "T", enum: ["a", "b"] },
    });
  });

  it("adds a string items type when there is none", () => {
    expect(setItemsEnum({ type: "array" }, ["a"]).items).toEqual({ type: "string", enum: ["a"] });
  });

  it("removes only the enum when cleared, and items entirely if nothing else is left", () => {
    expect(setItemsEnum({ type: "array", items: { type: "integer", enum: [1] } }, [])).toEqual({
      type: "array",
      items: { type: "integer" },
    });
    expect(setItemsEnum({ type: "array", items: { enum: [1] } }, [])).toEqual({ type: "array" });
  });

  it("leaves tuple items alone", () => {
    const prop: JSONSchema7 = { type: "array", items: [{ type: "string" }] };
    expect(setItemsEnum(prop, ["a"])).toBe(prop);
  });
});

// ─── Text adapters ──────────────────────────────────────────

describe("text adapters", () => {
  it("types values per field type", () => {
    expect(textToValue("3", "integer")).toBe(3);
    expect(textToValue("1.5", "number")).toBe(1.5);
    expect(textToValue("true", "boolean")).toBe(true);
    expect(textToValue("false", "boolean")).toBe(false);
    expect(textToValue("abc", "number")).toBeUndefined();
    expect(textToValue("yes", "boolean")).toBeUndefined();
    expect(textToList("true, yes, false", "boolean")).toEqual([true, false]);
    expect(textToValue("", "string")).toBeUndefined();
    expect(textToValue("x", "string")).toBe("x");
    expect(textToList("1, 2 ,3,", "integer")).toEqual([1, 2, 3]);
    expect(textToList("true, false", "boolean")).toEqual([true, false]);
    expect(textToList("a, , b", "string")).toEqual(["a", "b"]);
  });

  it("toNumber is undefined for empty or non-numeric text", () => {
    expect(toNumber("")).toBeUndefined();
    expect(toNumber("  ")).toBeUndefined();
    expect(toNumber("-")).toBeUndefined();
    expect(toNumber("Infinity")).toBeUndefined();
    expect(toNumber("-2.5")).toBe(-2.5);
  });

  it("shows editable scalars as text", () => {
    expect(valueToText(undefined, "string")).toEqual({ text: "", locked: false });
    expect(valueToText("x", "string")).toEqual({ text: "x", locked: false });
    expect(valueToText(2, "integer")).toEqual({ text: "2", locked: false });
    expect(valueToText(false, "boolean")).toEqual({ text: "false", locked: false });
  });

  it("locks values that cannot round-trip through text", () => {
    expect(valueToText({ a: 1 }, "object")).toEqual({ text: '{"a":1}', locked: true });
    expect(valueToText(["x"], "array")).toEqual({ text: '["x"]', locked: true });
    expect(valueToText("", "string").locked).toBe(true);
    expect(valueToText(1.5, "integer").locked).toBe(true);
    expect(valueToText(null, "string")).toEqual({ text: "null", locked: true });
    expect(valueToText(5, "string").locked).toBe(true); // would come back as "5"
  });

  it("lists: numeric and boolean stay typed; commas, padding, empty and non-arrays lock", () => {
    expect(listToText([1, 2], "integer")).toEqual({ text: "1, 2", locked: false });
    expect(listToText([true, false], "boolean")).toEqual({ text: "true, false", locked: false });
    expect(listToText(undefined, "string")).toEqual({ text: "", locked: false });
    expect(listToText(["Paris, FR", "Lyon"], "string")).toEqual({
      text: '["Paris, FR","Lyon"]',
      locked: true,
    });
    expect(listToText([" a"], "string").locked).toBe(true);
    expect(listToText([], "string").locked).toBe(true);
    expect(listToText("a", "string").locked).toBe(true);
    expect(listToText([{ a: 1 }], "string").locked).toBe(true);
  });

  it("items.enum text is typed by the items type and locks tuple items", () => {
    expect(itemsEnumText({ type: "array", items: { type: "integer", enum: [1, 2] } })).toEqual({
      text: "1, 2",
      locked: false,
    });
    expect(itemsEnumText({ type: "array" })).toEqual({ text: "", locked: false });
    expect(itemsEnumText({ type: "array", items: [{ type: "string" }] }).locked).toBe(true);
  });
});

// ─── manifestToMetadata ───────────────

describe("manifestToMetadata", () => {
  it("reads canonical display_name (snake_case)", () => {
    const m = {
      name: "@test/agent",
      version: "1.0.0",
      type: "agent",
      display_name: "Canonical Name",
    };
    const meta = manifestToMetadata(m);
    expect(meta.displayName).toBe("Canonical Name");
  });

  it("renders structured author object's name field as the editor text", () => {
    const m = {
      name: "@test/agent",
      version: "1.0.0",
      type: "agent",
      author: { name: "Jane Doe", email: "jane@example.com" },
    };
    const meta = manifestToMetadata(m);
    expect(meta.author).toBe("Jane Doe");
  });

  it("accepts bare string author verbatim", () => {
    const m = {
      name: "@test/agent",
      version: "1.0.0",
      type: "agent",
      author: "Jane Doe <jane@example.com>",
    };
    const meta = manifestToMetadata(m);
    expect(meta.author).toBe("Jane Doe <jane@example.com>");
  });
});

// ─── getRuntimeTools ──────────────────

describe("getRuntimeTools", () => {
  it("reads canonical runtime_tools (snake_case)", () => {
    const m = { runtime_tools: ["output", "note"] };
    expect(getRuntimeTools(m)).toEqual(["output", "note"]);
  });

  it("tolerates missing field", () => {
    expect(getRuntimeTools({})).toEqual([]);
  });

  it("tolerates malformed field", () => {
    expect(getRuntimeTools({ runtime_tools: "not-an-array" })).toEqual([]);
  });

  // Non-regression: `report` was a real runtime tool until it was replaced by
  // durable `outputs/` files. Agents saved back then still carry the id;
  // the editor must ignore it, never render a phantom checkbox for it, and
  // never surface a validation error to the user because of it.
  it("drops a retired tool id (`report`) it can no longer render", () => {
    expect(getRuntimeTools({ runtime_tools: ["output", "report", "log"] })).toEqual([
      "output",
      "log",
    ]);
  });
});

// ─── withNormalizedManifest ──────────────────

// Delegates to `dropRetiredRuntimeTools` + `dropRetiredDependencyKeys`
// (`@appstrate/core`). The former is gated on `type: "agent"` — the fixtures
// carry it because the only call site (`package-editor.tsx`) runs in the agent
// branch on a stored AFPS manifest, where `type` is required by the schema.
describe("withNormalizedManifest", () => {
  it("strips a retired id from the manifest loaded into the editor", () => {
    const m = { type: "agent", name: "@o/a", runtime_tools: ["report", "log"] };
    expect(withNormalizedManifest(m)).toEqual({
      type: "agent",
      name: "@o/a",
      runtime_tools: ["log"],
    });
  });

  it("removes the field entirely when nothing valid remains", () => {
    expect(
      withNormalizedManifest({ type: "agent", name: "@o/a", runtime_tools: ["report"] }),
    ).toEqual({ type: "agent", name: "@o/a" });
  });

  it("returns the same reference when there is nothing to drop", () => {
    const m = { type: "agent", name: "@o/a", runtime_tools: ["output"] };
    expect(withNormalizedManifest(m)).toBe(m);
    const noField = { type: "agent", name: "@o/a" };
    expect(withNormalizedManifest(noField)).toBe(noField);
  });

  // Settled empty-array representation, checked on the editor side of the
  // shared helper: loading an agent whose author wrote `runtime_tools: []`
  // must NOT rewrite the manifest. The key is deleted only when a DROP empties
  // the list — core is a dropper, not a canonicaliser. Mirrors
  // `packages/core/test/validation.test.ts`; both sides are pinned so the
  // editor and core cannot drift on the empty case again.
  it("leaves an author-written empty runtime_tools untouched on load", () => {
    const m = { type: "agent", name: "@o/a", runtime_tools: [] };
    expect(withNormalizedManifest(m)).toBe(m);
    expect(withNormalizedManifest(m)).toHaveProperty("runtime_tools");
  });

  // A draft can acquire a retired AFPS 1.x dependency key by importing a bundle
  // assembled from a legacy published version (that path tolerates it). The
  // author-direction save then REJECTS it, on a field the editor cannot
  // display — so it has to go on load, or the agent becomes uneditable (#1021).
  it("strips a retired AFPS 1.x dependency key on load", () => {
    const m = {
      type: "agent",
      name: "@o/a",
      dependencies: { tools: { "@appstrate/report": "^1.0.0" }, skills: { "@o/s": "^1.0.0" } },
    };
    expect(withNormalizedManifest(m)).toEqual({
      type: "agent",
      name: "@o/a",
      dependencies: { skills: { "@o/s": "^1.0.0" } },
    });
  });

  it("leaves an emptied dependencies map as {} — the shape the editor itself mints", () => {
    expect(
      withNormalizedManifest({
        type: "agent",
        name: "@o/a",
        dependencies: { providers: { "@o/gmail": "^1.0.0" } },
      }),
    ).toEqual({ type: "agent", name: "@o/a", dependencies: {} });
  });

  it("leaves the canonical dependency maps and an extension key untouched", () => {
    const m = {
      type: "agent",
      name: "@o/a",
      dependencies: { skills: {}, mcp_servers: {}, integrations: {}, _meta: { "dev.x/y": 1 } },
    };
    expect(withNormalizedManifest(m)).toBe(m);
  });

  it("strips a retired runtime tool and a retired dependency key in one pass", () => {
    expect(
      withNormalizedManifest({
        type: "agent",
        name: "@o/a",
        runtime_tools: ["report", "log"],
        dependencies: { tools: {} },
      }),
    ).toEqual({ type: "agent", name: "@o/a", runtime_tools: ["log"], dependencies: {} });
  });
});

// ─── Writers emit canonical AFPS keys only ──

describe("writers emit canonical AFPS keys", () => {
  it("metadataToManifestPatch — emits canonical display_name", () => {
    const patch = metadataToManifestPatch({
      id: "agent",
      scope: "test",
      version: "1.0.0",
      displayName: "New Canonical",
      description: "",
      author: "",
      keywords: [],
    });
    const serialized = JSON.parse(JSON.stringify(patch)) as Record<string, unknown>;
    expect(serialized.display_name).toBe("New Canonical");
    expect(serialized).not.toHaveProperty("displayName");
  });

  it("setRuntimeTools — writes canonical runtime_tools", () => {
    const m: Record<string, unknown> = {};
    setRuntimeTools(m, ["output"]);
    expect(m.runtime_tools).toEqual(["output"]);
  });

  it("setRuntimeTools — empty selection drops runtime_tools", () => {
    const m: Record<string, unknown> = { runtime_tools: ["output"] };
    setRuntimeTools(m, []);
    expect(m).not.toHaveProperty("runtime_tools");
  });
});
