// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  caretRange,
  defaultEditorState,
  getManifestName,
  getResourceEntries,
  setResourceEntries,
  schemaToFields,
  fieldsToSchema,
  manifestToSchemaFields,
  manifestToMetadata,
  getRuntimeTools,
} from "../utils";
import type { SchemaField } from "../schema-section";
import type { JSONSchemaObject } from "@appstrate/core/form";

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

  // Niveau 2 — version lives in `dependencies.integrations` (bare
  // string), tool/scope selection lives in the top-level `integrations`
  // block. These tests pin the round-trip across both halves.
  describe("integrations (niveau 2 two-block layout)", () => {
    it("reads version from deps with no selection block", () => {
      const m = { dependencies: { integrations: { "@vendor/gmail": "^1.0.0" } } };
      expect(getResourceEntries(m, "integrations")).toEqual([
        { id: "@vendor/gmail", version: "^1.0.0" },
      ]);
    });

    it("merges version + selection from the two blocks", () => {
      const m = {
        dependencies: { integrations: { "@vendor/gmail": "^1.0.0" } },
        integrations: {
          "@vendor/gmail": { tools: ["list_messages", "send_message"], scopes: ["delete"] },
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

    it("writes the canonical inline object form when tools is an explicit array (even empty)", () => {
      // AFPS 2.0.2 §4.1 — dep value is `{ version, tools? }`. The Appstrate-
      // invented top-level `manifest.integrations` block is no longer written;
      // it is only read for legacy back-compat.
      const m: Record<string, unknown> = { dependencies: {} };
      setResourceEntries(m, "integrations", [
        { id: "@vendor/gmail", version: "^1.0.0", tools: [] },
      ]);
      expect((m.dependencies as Record<string, unknown>).integrations).toEqual({
        "@vendor/gmail": { version: "^1.0.0", tools: [] },
      });
      expect(m.integrations).toBeUndefined();
    });

    it("writes tools + scopes inline on the canonical dep entry (§4.1)", () => {
      const m: Record<string, unknown> = { dependencies: {} };
      setResourceEntries(m, "integrations", [
        { id: "@vendor/gmail", version: "^1.0.0", tools: ["list_messages"], scopes: ["delete"] },
      ]);
      expect((m.dependencies as Record<string, unknown>).integrations).toEqual({
        "@vendor/gmail": {
          version: "^1.0.0",
          scopes: ["delete"],
          tools: ["list_messages"],
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
    // Canonical AFPS 2.0 manifest version — was wrongly "1.1" pre-rename.
    expect(state.manifest.schema_version).toBe("2.0");
    expect(state.manifest.schemaVersion).toBeUndefined();
    expect(state.prompt).toBe("");
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
    const fields = schemaToFields(schema, "output", { property_order: ["summary", "count"] });
    expect(fields).toHaveLength(2);
    expect(fields[0]!.key).toBe("summary");
    expect(fields[0]!.required).toBe(true);
    expect(fields[1]!.key).toBe("count");
    expect(fields[1]!.required).toBe(false);

    const result = fieldsToSchema(fields, "output");
    expect(result).not.toBeNull();
    expect(result!.schema.properties.summary!.type).toBe("string");
    expect(result!.schema.required).toEqual(["summary"]);
  });

  it("roundtrips config schema with defaults and enums", () => {
    const schema = {
      type: "object",
      properties: {
        mode: { type: "string", description: "Mode", default: "fast", enum: ["fast", "slow"] },
      },
    } satisfies JSONSchemaObject;
    const fields = schemaToFields(schema, "config", { property_order: ["mode"] });
    expect(fields[0]!.default).toBe("fast");
    expect(fields[0]!.enumValues).toBe("fast, slow");

    const result = fieldsToSchema(fields, "config");
    expect(result!.schema.properties.mode!.default).toBe("fast");
    expect(result!.schema.properties.mode!.enum).toEqual(["fast", "slow"]);
  });

  it("roundtrips input schema with placeholder via ui_hints", () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
    } satisfies JSONSchemaObject;
    const wrapper = {
      ui_hints: { query: { placeholder: "Enter query..." } },
      property_order: ["query"],
    };
    const fields = schemaToFields(schema, "input", wrapper);
    expect(fields[0]!.placeholder).toBe("Enter query...");

    const result = fieldsToSchema(fields, "input");
    expect(result!.ui_hints?.query?.placeholder).toBe("Enter query...");
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
      file_constraints: { doc: { accept: ".pdf", max_size: 10485760 } },
      property_order: ["doc"],
    };
    const fields = schemaToFields(schema, "input", wrapper);
    expect(fields[0]!.type).toBe("string");
    expect(fields[0]!.isFile).toBe(true);
    expect(fields[0]!.multiple).toBe(true);
    expect(fields[0]!.accept).toBe(".pdf");
    expect(fields[0]!.maxFiles).toBe("5");

    const result = fieldsToSchema(fields, "input");
    const docProp = result!.schema.properties.doc!;
    const docItems =
      typeof docProp.items === "object" && !Array.isArray(docProp.items) ? docProp.items : null;
    expect(docProp.type).toBe("array");
    expect(docItems?.format).toBe("uri");
    expect(docItems?.contentMediaType).toBe("application/octet-stream");
    expect(result!.schema.properties.doc!.maxItems).toBe(5);
    expect(result!.file_constraints?.doc?.accept).toBe(".pdf");
    expect(result!.file_constraints?.doc?.max_size).toBe(10485760);
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
  "max_size",
  "multiple",
  "maxFiles",
  "propertyOrder",
  "property_order",
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
        type: "string",
        isFile: true,
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
        type: "string",
        isFile: true,
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

  it("placeholder goes to ui_hints, not into schema properties", () => {
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
    // In wrapper ui_hints
    expect(result!.ui_hints?.email?.placeholder).toBe("user@example.com");
  });

  it("file constraints go to file_constraints, not into schema properties", () => {
    const fields = [
      {
        _id: "1",
        key: "doc",
        type: "string",
        isFile: true,
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
    expect(result!.schema.properties.doc).not.toHaveProperty("max_size");
    expect(result!.schema.properties.doc).not.toHaveProperty("maxSize");
    expect(result!.schema.properties.doc).not.toHaveProperty("multiple");
    expect(result!.schema.properties.doc).not.toHaveProperty("maxFiles");
    // In wrapper
    expect(result!.file_constraints?.doc?.accept).toBe(".pdf");
    expect(result!.file_constraints?.doc?.max_size).toBe(5242880);
  });

  it("property_order is at wrapper level, not in schema", () => {
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
    expect(result!.schema).not.toHaveProperty("property_order");
    expect(result!.schema).not.toHaveProperty("propertyOrder");
    // In wrapper
    expect(result!.property_order).toEqual(["a", "b"]);
  });
});

// ─── AFPS 1.x lenient-reader compat regression ──────────────
//
// Manifests saved by the pre-2.0 editor still live in users' databases
// with camelCase wrapper fields. `manifestToSchemaFields` must accept
// both shapes — re-saving migrates the manifest forward to snake_case.

describe("manifestToSchemaFields — AFPS 1.x lenient compat", () => {
  it("reads a legacy manifest with camelCase wrapper fields", () => {
    const legacyManifest: Record<string, unknown> = {
      input: {
        schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search" },
            doc: {
              type: "string",
              format: "uri",
              contentMediaType: "application/octet-stream",
              description: "Upload",
            },
          },
          required: ["query"],
        },
        uiHints: { query: { placeholder: "type…" } },
        fileConstraints: { doc: { accept: ".pdf", maxSize: 1_000_000 } },
        propertyOrder: ["doc", "query"],
      },
    };
    const input = manifestToSchemaFields(legacyManifest).input!;
    // property_order respected → doc first, query second
    expect(input.map((f) => f.key)).toEqual(["doc", "query"]);
    const queryField = input.find((f) => f.key === "query")!;
    expect(queryField.placeholder).toBe("type…");
    const docField = input.find((f) => f.key === "doc")!;
    expect(docField.isFile).toBe(true);
    expect(docField.accept).toBe(".pdf");
    expect(docField.maxSize).toBe("1000000");
  });

  it("prefers canonical snake_case when both shapes are present", () => {
    const mixedManifest: Record<string, unknown> = {
      input: {
        schema: {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
        },
        property_order: ["a", "b"],
        propertyOrder: ["b", "a"],
        ui_hints: { a: { placeholder: "canonical" } },
        uiHints: { a: { placeholder: "legacy" } },
      },
    };
    const input = manifestToSchemaFields(mixedManifest).input!;
    expect(input.map((f) => f.key)).toEqual(["a", "b"]);
    expect(input.find((f) => f.key === "a")!.placeholder).toBe("canonical");
  });
});

// ─── manifestToMetadata — v1 camelCase compat ───────────────

describe("manifestToMetadata — v1 → v2 compat", () => {
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

  it("falls back to camelCase displayName for legacy manifests", () => {
    const m = {
      name: "@test/agent",
      version: "1.0.0",
      type: "agent",
      displayName: "Legacy Name",
    };
    const meta = manifestToMetadata(m);
    expect(meta.displayName).toBe("Legacy Name");
  });

  it("prefers canonical display_name when both are present", () => {
    const m = {
      name: "@test/agent",
      version: "1.0.0",
      type: "agent",
      display_name: "Canonical",
      displayName: "Legacy",
    };
    const meta = manifestToMetadata(m);
    expect(meta.displayName).toBe("Canonical");
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

// ─── getRuntimeTools — v1 camelCase compat ──────────────────

describe("getRuntimeTools — v1 → v2 compat", () => {
  it("reads canonical runtime_tools (snake_case)", () => {
    const m = { runtime_tools: ["output", "note"] };
    expect(getRuntimeTools(m)).toEqual(["output", "note"]);
  });

  it("falls back to camelCase runtimeTools for legacy manifests", () => {
    const m = { runtimeTools: ["output", "log"] };
    expect(getRuntimeTools(m)).toEqual(["output", "log"]);
  });

  it("prefers canonical runtime_tools when both are present", () => {
    const m = { runtime_tools: ["output"], runtimeTools: ["note"] };
    expect(getRuntimeTools(m)).toEqual(["output"]);
  });

  it("tolerates missing field", () => {
    expect(getRuntimeTools({})).toEqual([]);
  });

  it("tolerates malformed field", () => {
    expect(getRuntimeTools({ runtime_tools: "not-an-array" })).toEqual([]);
  });
});

// ─── getResourceEntries — v1 providersConfiguration compat ──

describe("getResourceEntries — providersConfiguration v1 alias", () => {
  it("reads scopes from v1 camelCase providersConfiguration", () => {
    const m = {
      dependencies: { integrations: { "@scope/int": "^1.0.0" } },
      providersConfiguration: {
        "@scope/int": { scopes: ["read", "write"] },
      },
    };
    const entries = getResourceEntries(m, "integrations");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.scopes).toEqual(["read", "write"]);
  });

  it("reads tools from v1 camelCase providersConfiguration", () => {
    const m = {
      dependencies: { integrations: { "@scope/int": "^1.0.0" } },
      providersConfiguration: {
        "@scope/int": { tools: ["list_x", "create_x"] },
      },
    };
    const entries = getResourceEntries(m, "integrations");
    expect(entries[0]!.tools).toEqual(["list_x", "create_x"]);
  });

  it("canonical dependencies.integrations object wins over providersConfiguration", () => {
    const m = {
      dependencies: {
        integrations: {
          "@scope/int": { version: "^1.0.0", scopes: ["canonical"] },
        },
      },
      providersConfiguration: {
        "@scope/int": { scopes: ["v1-legacy"] },
      },
    };
    const entries = getResourceEntries(m, "integrations");
    expect(entries[0]!.scopes).toEqual(["canonical"]);
  });

  it("setResourceEntries — drops providersConfiguration after canonical write", () => {
    const m: Record<string, unknown> = {
      dependencies: { integrations: { "@scope/int": "^1.0.0" } },
      providersConfiguration: {
        "@scope/int": { tools: ["legacy"] },
      },
    };
    setResourceEntries(m, "integrations", [
      { id: "@scope/int", version: "^1.0.0", tools: ["new_canonical"] },
    ]);
    expect(m.providersConfiguration).toBeUndefined();
    const deps = m.dependencies as Record<string, Record<string, unknown>>;
    expect(deps.integrations!["@scope/int"]).toMatchObject({
      version: "^1.0.0",
      tools: ["new_canonical"],
    });
  });
});
