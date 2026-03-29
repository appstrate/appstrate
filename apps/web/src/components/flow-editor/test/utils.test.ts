import { describe, it, expect } from "bun:test";
import {
  defaultEditorState,
  getManifestName,
  getProviderEntries,
  setProviderEntries,
  getResourceEntries,
  setResourceEntries,
  schemaToFields,
  fieldsToSchema,
} from "../utils";
import type { SchemaField } from "../schema-section";
import type { JSONSchemaObject } from "@appstrate/core/form";

// ─── getManifestName ────────────────────────────────────────

describe("getManifestName", () => {
  it("parses scoped name", () => {
    expect(getManifestName({ name: "@my-org/my-flow" })).toEqual({
      scope: "my-org",
      id: "my-flow",
    });
  });

  it("returns empty scope for unscoped name", () => {
    expect(getManifestName({ name: "my-flow" })).toEqual({ scope: "", id: "my-flow" });
  });

  it("handles missing name", () => {
    expect(getManifestName({})).toEqual({ scope: "", id: "" });
  });
});

// ─── Provider entries ───────────────────────────────────────

describe("getProviderEntries / setProviderEntries", () => {
  it("reads providers from manifest", () => {
    const m = {
      dependencies: { providers: { "@org/gmail": "1.0.0", "@org/slack": "2.0.0" } },
      providersConfiguration: {
        "@org/gmail": { scopes: ["gmail.readonly"] },
      },
    };
    const entries = getProviderEntries(m);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      id: "@org/gmail",
      version: "1.0.0",
      scopes: ["gmail.readonly"],
    });
    expect(entries[1]).toEqual({
      id: "@org/slack",
      version: "2.0.0",
      scopes: [],
    });
  });

  it("roundtrips through set/get", () => {
    const entries = [
      {
        id: "@org/gmail",
        version: "1.0.0",
        scopes: ["gmail.send"],
      },
      { id: "@org/slack", version: "*", scopes: [] },
    ];
    const m: Record<string, unknown> = { dependencies: { providers: {} } };
    setProviderEntries(m, entries);
    const result = getProviderEntries(m);
    expect(result).toEqual(entries);
  });

  it("filters empty ids", () => {
    const m: Record<string, unknown> = { dependencies: { providers: {} } };
    setProviderEntries(m, [
      { id: "", version: "*", scopes: [] },
      { id: "@org/gmail", version: "1.0.0", scopes: [] },
    ]);
    expect(getProviderEntries(m)).toHaveLength(1);
  });

  it("cleans up providersConfiguration when no config needed", () => {
    const m: Record<string, unknown> = { dependencies: { providers: {} } };
    setProviderEntries(m, [
      { id: "@org/gmail", version: "1.0.0", scopes: [] },
    ]);
    expect(m.providersConfiguration).toBeUndefined();
  });
});

// ─── Resource entries ───────────────────────────────────────

describe("getResourceEntries / setResourceEntries", () => {
  it("reads skills from manifest", () => {
    const m = { dependencies: { providers: {}, skills: { "@org/research": "1.0.0" } } };
    expect(getResourceEntries(m, "skills")).toEqual([{ id: "@org/research", version: "1.0.0" }]);
  });

  it("returns empty array when no deps", () => {
    const m = { dependencies: { providers: {} } };
    expect(getResourceEntries(m, "tools")).toEqual([]);
  });

  it("roundtrips through set/get", () => {
    const m: Record<string, unknown> = { dependencies: { providers: {} } };
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
      dependencies: { providers: {}, skills: { "@org/a": "1.0.0" } },
    };
    setResourceEntries(m, "skills", []);
    expect((m.dependencies as Record<string, unknown>).skills).toBeUndefined();
  });
});

// ─── defaultEditorState ─────────────────────────────────────

describe("defaultEditorState", () => {
  it("returns valid manifest structure", () => {
    const state = defaultEditorState("my-org", "user@test.com");
    expect(state.manifest.name).toBe("@my-org/");
    expect(state.manifest.author).toBe("user@test.com");
    expect(state.manifest.type).toBe("flow");
    expect(state.manifest.version).toBe("1.0.0");
    expect(state.prompt).toBe("");
  });

  it("handles missing org slug", () => {
    const state = defaultEditorState();
    expect(state.manifest.name).toBe("");
  });
});

// ─── Schema field conversion ────────────────────────────────

describe("schemaToFields / fieldsToSchema roundtrip", () => {
  it("roundtrips output schema", () => {
    const schema = {
      type: "object",
      properties: {
        summary: { type: "string", description: "Brief summary" },
        count: { type: "number", description: "Total count" },
      },
      required: ["summary"],
    } satisfies JSONSchemaObject;
    const fields = schemaToFields(schema, "output", { propertyOrder: ["summary", "count"] });
    expect(fields).toHaveLength(2);
    expect(fields[0]!.key).toBe("summary");
    expect(fields[0]!.required).toBe(true);
    expect(fields[1]!.key).toBe("count");
    expect(fields[1]!.required).toBe(false);

    const result = fieldsToSchema(fields, "output");
    expect(result).not.toBeNull();
    expect(result!.schema.properties.summary.type).toBe("string");
    expect(result!.schema.required).toEqual(["summary"]);
  });

  it("roundtrips config schema with defaults and enums", () => {
    const schema = {
      type: "object",
      properties: {
        mode: { type: "string", description: "Mode", default: "fast", enum: ["fast", "slow"] },
      },
    } satisfies JSONSchemaObject;
    const fields = schemaToFields(schema, "config", { propertyOrder: ["mode"] });
    expect(fields[0]!.default).toBe("fast");
    expect(fields[0]!.enumValues).toBe("fast, slow");

    const result = fieldsToSchema(fields, "config");
    expect(result!.schema.properties.mode.default).toBe("fast");
    expect(result!.schema.properties.mode.enum).toEqual(["fast", "slow"]);
  });

  it("roundtrips input schema with placeholder via uiHints", () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
    } satisfies JSONSchemaObject;
    const wrapper = {
      uiHints: { query: { placeholder: "Enter query..." } },
      propertyOrder: ["query"],
    };
    const fields = schemaToFields(schema, "input", wrapper);
    expect(fields[0]!.placeholder).toBe("Enter query...");

    const result = fieldsToSchema(fields, "input");
    expect(result!.uiHints?.query?.placeholder).toBe("Enter query...");
  });

  it("roundtrips input schema with file field", () => {
    const schema = {
      type: "object",
      properties: {
        doc: {
          type: "array",
          items: { type: "string", format: "uri", contentMediaType: "application/octet-stream" },
          maxItems: 5,
          description: "Upload docs",
        },
      },
    } satisfies JSONSchemaObject;
    const wrapper = {
      fileConstraints: { doc: { accept: ".pdf", maxSize: 10485760 } },
      propertyOrder: ["doc"],
    };
    const fields = schemaToFields(schema, "input", wrapper);
    expect(fields[0]!.type).toBe("file");
    expect(fields[0]!.multiple).toBe(true);
    expect(fields[0]!.accept).toBe(".pdf");
    expect(fields[0]!.maxFiles).toBe("5");

    const result = fieldsToSchema(fields, "input");
    const docProp = result!.schema.properties.doc;
    const docItems =
      typeof docProp.items === "object" && !Array.isArray(docProp.items) ? docProp.items : null;
    expect(docProp.type).toBe("array");
    expect(docItems?.format).toBe("uri");
    expect(docItems?.contentMediaType).toBe("application/octet-stream");
    expect(result!.schema.properties.doc.maxItems).toBe(5);
    expect(result!.fileConstraints?.doc?.accept).toBe(".pdf");
    expect(result!.fileConstraints?.doc?.maxSize).toBe(10485760);
  });

  it("returns null for empty fields", () => {
    expect(fieldsToSchema([], "output")).toBeNull();
  });

  it("returns empty array for undefined schema", () => {
    expect(schemaToFields(undefined, "output")).toEqual([]);
  });
});

// ─── JSON Schema purity — fieldsToSchema output ─────────────

const BANNED_SCHEMA_KEYWORDS = [
  "placeholder",
  "accept",
  "maxSize",
  "multiple",
  "maxFiles",
  "propertyOrder",
];

function findKeywordInObject(obj: unknown, keyword: string, path = ""): string[] {
  const found: string[] = [];
  if (obj && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key === keyword) found.push(`${path}.${key}`);
      if (value && typeof value === "object") {
        found.push(...findKeywordInObject(value, keyword, `${path}.${key}`));
      }
    }
  }
  return found;
}

describe("fieldsToSchema — JSON Schema purity", () => {
  it("schema never contains non-standard keywords for input with file + text fields", () => {
    const fields = [
      {
        _id: "1",
        key: "query",
        type: "string",
        description: "Search",
        required: true,
        placeholder: "Enter query...",
        default: "",
      },
      {
        _id: "2",
        key: "doc",
        type: "file",
        description: "Upload",
        required: false,
        accept: ".pdf,.docx",
        maxSize: "10485760",
        multiple: true,
        maxFiles: "5",
      },
    ];
    const result = fieldsToSchema(fields as SchemaField[], "input");
    expect(result).not.toBeNull();

    // Check the schema object (not the wrapper) for banned keywords
    for (const keyword of BANNED_SCHEMA_KEYWORDS) {
      const violations = findKeywordInObject(result!.schema, keyword);
      expect(violations).toEqual([]);
    }
  });

  it("schema never contains type:'file'", () => {
    const fields = [
      {
        _id: "1",
        key: "attachment",
        type: "file",
        description: "File",
        required: false,
        accept: "",
        maxSize: "",
        multiple: false,
        maxFiles: "",
      },
    ];
    const result = fieldsToSchema(fields as SchemaField[], "input");
    expect(result).not.toBeNull();

    const violations = findKeywordInObject(result!.schema, "type")
      .map((path) => {
        const parts = path.split(".");
        let obj: unknown = result!.schema;
        for (const p of parts.slice(1)) {
          obj = (obj as Record<string, unknown>)?.[p];
        }
        return { path, value: obj };
      })
      .filter((v) => v.value === "file");

    expect(violations).toEqual([]);
  });

  it("placeholder goes to uiHints, not into schema properties", () => {
    const fields = [
      {
        _id: "1",
        key: "email",
        type: "string",
        description: "Email",
        required: true,
        placeholder: "user@example.com",
        default: "",
      },
    ];
    const result = fieldsToSchema(fields as SchemaField[], "input");
    expect(result).not.toBeNull();

    // Not in schema
    expect(result!.schema.properties.email).not.toHaveProperty("placeholder");
    // In wrapper uiHints
    expect(result!.uiHints?.email?.placeholder).toBe("user@example.com");
  });

  it("file constraints go to fileConstraints, not into schema properties", () => {
    const fields = [
      {
        _id: "1",
        key: "doc",
        type: "file",
        description: "Document",
        required: false,
        accept: ".pdf",
        maxSize: "5242880",
        multiple: false,
        maxFiles: "",
      },
    ];
    const result = fieldsToSchema(fields as SchemaField[], "input");
    expect(result).not.toBeNull();

    // Not in schema
    expect(result!.schema.properties.doc).not.toHaveProperty("accept");
    expect(result!.schema.properties.doc).not.toHaveProperty("maxSize");
    expect(result!.schema.properties.doc).not.toHaveProperty("multiple");
    expect(result!.schema.properties.doc).not.toHaveProperty("maxFiles");
    // In wrapper
    expect(result!.fileConstraints?.doc?.accept).toBe(".pdf");
    expect(result!.fileConstraints?.doc?.maxSize).toBe(5242880);
  });

  it("propertyOrder is at wrapper level, not in schema", () => {
    const fields = [
      {
        _id: "1",
        key: "a",
        type: "string",
        description: "",
        required: false,
        placeholder: "",
        default: "",
      },
      {
        _id: "2",
        key: "b",
        type: "number",
        description: "",
        required: false,
        placeholder: "",
        default: "",
      },
    ];
    const result = fieldsToSchema(fields as SchemaField[], "input");
    expect(result).not.toBeNull();

    // Not in schema
    expect(result!.schema).not.toHaveProperty("propertyOrder");
    // In wrapper
    expect(result!.propertyOrder).toEqual(["a", "b"]);
  });
});
