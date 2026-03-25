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
        "@org/gmail": { scopes: ["gmail.readonly"], connectionMode: "admin" },
      },
    };
    const entries = getProviderEntries(m);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      id: "@org/gmail",
      version: "1.0.0",
      scopes: ["gmail.readonly"],
      connectionMode: "admin",
    });
    expect(entries[1]).toEqual({
      id: "@org/slack",
      version: "2.0.0",
      scopes: [],
      connectionMode: "user",
    });
  });

  it("roundtrips through set/get", () => {
    const entries = [
      {
        id: "@org/gmail",
        version: "1.0.0",
        scopes: ["gmail.send"],
        connectionMode: "admin" as const,
      },
      { id: "@org/slack", version: "*", scopes: [], connectionMode: "user" as const },
    ];
    const m: Record<string, unknown> = { dependencies: { providers: {} } };
    setProviderEntries(m, entries);
    const result = getProviderEntries(m);
    expect(result).toEqual(entries);
  });

  it("filters empty ids", () => {
    const m: Record<string, unknown> = { dependencies: { providers: {} } };
    setProviderEntries(m, [
      { id: "", version: "*", scopes: [], connectionMode: "user" },
      { id: "@org/gmail", version: "1.0.0", scopes: [], connectionMode: "user" },
    ]);
    expect(getProviderEntries(m)).toHaveLength(1);
  });

  it("cleans up providersConfiguration when no config needed", () => {
    const m: Record<string, unknown> = { dependencies: { providers: {} } };
    setProviderEntries(m, [
      { id: "@org/gmail", version: "1.0.0", scopes: [], connectionMode: "user" },
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
      type: "object" as const,
      properties: {
        summary: { type: "string", description: "Brief summary" },
        count: { type: "number", description: "Total count" },
      },
      required: ["summary"],
      propertyOrder: ["summary", "count"],
    };
    const fields = schemaToFields(schema, "output");
    expect(fields).toHaveLength(2);
    expect(fields[0]!.key).toBe("summary");
    expect(fields[0]!.required).toBe(true);
    expect(fields[1]!.key).toBe("count");
    expect(fields[1]!.required).toBe(false);

    const result = fieldsToSchema(fields, "output");
    expect(result).not.toBeNull();
    expect(result!.properties.summary.type).toBe("string");
    expect(result!.required).toEqual(["summary"]);
  });

  it("roundtrips config schema with defaults and enums", () => {
    const schema = {
      type: "object" as const,
      properties: {
        mode: { type: "string", description: "Mode", default: "fast", enum: ["fast", "slow"] },
      },
      propertyOrder: ["mode"],
    };
    const fields = schemaToFields(schema, "config");
    expect(fields[0]!.default).toBe("fast");
    expect(fields[0]!.enumValues).toBe("fast, slow");

    const result = fieldsToSchema(fields, "config");
    expect(result!.properties.mode.default).toBe("fast");
    expect(result!.properties.mode.enum).toEqual(["fast", "slow"]);
  });

  it("roundtrips input schema with placeholder", () => {
    const schema = {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query", placeholder: "Enter query..." },
      },
      propertyOrder: ["query"],
    };
    const fields = schemaToFields(schema, "input");
    expect(fields[0]!.placeholder).toBe("Enter query...");

    const result = fieldsToSchema(fields, "input");
    expect(result!.properties.query.placeholder).toBe("Enter query...");
  });

  it("returns null for empty fields", () => {
    expect(fieldsToSchema([], "output")).toBeNull();
  });

  it("returns empty array for undefined schema", () => {
    expect(schemaToFields(undefined, "output")).toEqual([]);
  });
});
