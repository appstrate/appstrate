import { describe, it, expect, beforeEach } from "bun:test";

/**
 * Tests for buildDataSchema() in structured-output extension.
 *
 * Since the extension reads process.env.OUTPUT_SCHEMA at import time,
 * we must set the env var BEFORE dynamically importing the module.
 * Each test uses a fresh import via cache-busting query string.
 */

/** Helper: create a mock pi that captures registered tools. */
function createMockPi() {
  const tools: any[] = [];
  return {
    tools,
    registerTool(config: any) {
      tools.push(config);
    },
  };
}

/** Helper: import the extension with a fresh module evaluation. */
async function importExtension(envValue?: string) {
  // Set or clear the env var before import
  if (envValue !== undefined) {
    process.env.OUTPUT_SCHEMA = envValue;
  } else {
    delete process.env.OUTPUT_SCHEMA;
  }

  // Cache-bust to force re-evaluation of module-level code
  const cacheBuster = `${Date.now()}-${Math.random()}`;
  const mod = await import(`../extensions/structured-output.ts?v=${cacheBuster}`);
  const factory = mod.default;

  const pi = createMockPi();
  factory(pi);
  return pi.tools[0];
}

describe("structured-output extension", () => {
  beforeEach(() => {
    delete process.env.OUTPUT_SCHEMA;
  });

  it("uses generic object schema when OUTPUT_SCHEMA is not set", async () => {
    const tool = await importExtension(undefined);

    expect(tool.name).toBe("structured_output");
    // The data parameter should be a generic object
    const dataSchema = tool.parameters.properties.data;
    expect(dataSchema.type).toBe("object");
    expect(dataSchema.properties).toBeUndefined();
  });

  it("injects output schema properties when OUTPUT_SCHEMA is set", async () => {
    const schema = {
      type: "object",
      properties: {
        total: { type: "number", description: "Total count" },
        items: { type: "array", items: { type: "string" } },
      },
      required: ["total", "items"],
    };

    const tool = await importExtension(JSON.stringify(schema));

    const dataSchema = tool.parameters.properties.data;
    expect(dataSchema.type).toBe("object");
    expect(dataSchema.properties.total.type).toBe("number");
    expect(dataSchema.properties.items.type).toBe("array");
  });

  it("strips required from injected schema to allow incremental calls", async () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name", "age"],
    };

    const tool = await importExtension(JSON.stringify(schema));

    const dataSchema = tool.parameters.properties.data;
    expect(dataSchema.required).toBeUndefined();
    // Properties are still present
    expect(dataSchema.properties.name.type).toBe("string");
    expect(dataSchema.properties.age.type).toBe("number");
  });

  it("falls back to generic schema on invalid JSON", async () => {
    const tool = await importExtension("not-valid-json{{{");

    const dataSchema = tool.parameters.properties.data;
    expect(dataSchema.type).toBe("object");
    expect(dataSchema.properties).toBeUndefined();
  });

  it("preserves description from output schema", async () => {
    const schema = {
      type: "object",
      description: "Customer order summary",
      properties: {
        orderId: { type: "string" },
      },
    };

    const tool = await importExtension(JSON.stringify(schema));

    const dataSchema = tool.parameters.properties.data;
    expect(dataSchema.description).toBe("Customer order summary");
  });

  it("adds default description when output schema has none", async () => {
    const schema = {
      type: "object",
      properties: {
        count: { type: "number" },
      },
    };

    const tool = await importExtension(JSON.stringify(schema));

    const dataSchema = tool.parameters.properties.data;
    expect(dataSchema.description).toBe("JSON object to merge into the structured output");
  });
});
