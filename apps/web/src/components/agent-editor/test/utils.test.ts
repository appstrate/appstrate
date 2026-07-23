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
  metadataToManifestPatch,
  getRuntimeTools,
  setRuntimeTools,
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
    // Canonical AFPS 0.x draft manifest version.
    expect(state.manifest.schema_version).toBe("0.2");
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
    const result = fieldsToSchema(fields, "input");
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
    const result = fieldsToSchema(fields, "input");
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
    const result = fieldsToSchema(fields, "input");
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
    const result = fieldsToSchema(fields, "input");
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
    const result = fieldsToSchema(fields, "input");
    expect(result).not.toBeNull();

    // Not in schema
    expect(result!.schema).not.toHaveProperty("property_order");
    expect(result!.schema).not.toHaveProperty("propertyOrder");
    // In wrapper
    expect(result!.property_order).toEqual(["a", "b"]);
  });
});

// ─── manifestToSchemaFields — canonical AFPS wrapper reads ──

describe("manifestToSchemaFields — canonical snake_case wrappers", () => {
  it("reads canonical snake_case wrapper fields", () => {
    const manifest: Record<string, unknown> = {
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
        ui_hints: { query: { placeholder: "type…" } },
        file_constraints: { doc: { accept: ".pdf", max_size: 1_000_000 } },
        property_order: ["doc", "query"],
      },
    };
    const input = manifestToSchemaFields(manifest).input!;
    // property_order respected → doc first, query second
    expect(input.map((f) => f.key)).toEqual(["doc", "query"]);
    const queryField = input.find((f) => f.key === "query")!;
    expect(queryField.placeholder).toBe("type…");
    const docField = input.find((f) => f.key === "doc")!;
    expect(docField.isFile).toBe(true);
    expect(docField.accept).toBe(".pdf");
    expect(docField.maxSize).toBe("1000000");
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

  it("drops entries not in the catalog (e.g. a removed `report` tool)", () => {
    expect(getRuntimeTools({ runtime_tools: ["output", "report", "log"] })).toEqual([
      "output",
      "log",
    ]);
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

  it("fieldsToSchema — wrapper output has NO camelCase keys (non-canonical fileConstraints/uiHints/propertyOrder/maxSize)", () => {
    const fields: SchemaField[] = [
      {
        _id: "1",
        key: "doc",
        type: "string",
        isFile: true,
        description: "Document",
        required: false,
        accept: ".pdf",
        maxSize: "10485760",
        multiple: false,
        maxFiles: "",
        placeholder: "",
        default: "",
      },
      {
        _id: "2",
        key: "q",
        type: "string",
        description: "Query",
        required: true,
        placeholder: "type…",
        default: "",
      },
    ];
    const wrapper = fieldsToSchema(fields, "input");
    expect(wrapper).not.toBeNull();
    // Canonical snake_case keys present
    expect(wrapper).toHaveProperty("file_constraints");
    expect(wrapper).toHaveProperty("ui_hints");
    expect(wrapper).toHaveProperty("property_order");
    // Non-canonical camelCase keys absent at the wrapper level
    expect(wrapper).not.toHaveProperty("fileConstraints");
    expect(wrapper).not.toHaveProperty("uiHints");
    expect(wrapper).not.toHaveProperty("propertyOrder");
    // And per-property maxSize is NOT in any FileConstraint
    for (const fc of Object.values(wrapper!.file_constraints ?? {})) {
      expect(fc).not.toHaveProperty("maxSize");
      expect(fc).toHaveProperty("max_size");
    }
  });

  it("fieldsToSchema — when caller replaces the wrapper wholesale, non-canonical camelCase keys vanish from the persisted manifest", () => {
    // Simulates: previous manifest carries non-canonical camelCase wrapper
    // keys; editor computes a fresh wrapper via `fieldsToSchema` and the
    // caller does `updateManifest({ input: wrapper })` (replace, not merge).
    const camelCaseManifest: Record<string, unknown> = {
      input: {
        schema: { type: "object", properties: { x: { type: "string" } } },
        fileConstraints: { x: { accept: ".pdf", maxSize: 1000 } },
        uiHints: { x: { placeholder: "old" } },
        propertyOrder: ["x"],
      },
    };
    const wrapper = fieldsToSchema(
      [
        {
          _id: "1",
          key: "x",
          type: "string",
          description: "X",
          required: false,
          placeholder: "new",
          default: "",
        },
      ],
      "input",
    );
    camelCaseManifest.input = wrapper;
    // Round-trip via JSON to mimic persistence
    const persisted = JSON.parse(JSON.stringify(camelCaseManifest)) as Record<string, unknown>;
    const input = persisted.input as Record<string, unknown>;
    expect(input).not.toHaveProperty("fileConstraints");
    expect(input).not.toHaveProperty("uiHints");
    expect(input).not.toHaveProperty("propertyOrder");
    expect(input).toHaveProperty("ui_hints");
    expect(input).toHaveProperty("property_order");
  });
});
