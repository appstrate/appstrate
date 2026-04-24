// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";

/**
 * Tests for the output system tool.
 *
 * Since the extension reads process.env.OUTPUT_SCHEMA at import time,
 * we must set the env var BEFORE dynamically importing the module.
 * Each test uses a fresh import via cache-busting query string.
 *
 * The source lives in system-packages/tool-output-2.0.0/tool.ts but
 * depends on @mariozechner/pi-ai (installed in runtime-pi/node_modules).
 * We import from system-packages — Bun resolves the Pi SDK via the
 * runtime-pi workspace's node_modules.
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

/** Absolute path to the output extension source. */
const OUTPUT_PATH = new URL(
  "../../scripts/system-packages/tool-output-2.0.0/tool.ts",
  import.meta.url,
).pathname;

/** Helper: import the extension with a fresh module evaluation. */
async function importExtension(envValue?: string) {
  if (envValue !== undefined) {
    process.env.OUTPUT_SCHEMA = envValue;
  } else {
    delete process.env.OUTPUT_SCHEMA;
  }

  const cacheBuster = `${Date.now()}-${Math.random()}`;
  const mod = await import(`${OUTPUT_PATH}?v=${cacheBuster}`);
  const factory = mod.default;

  const pi = createMockPi();
  factory(pi);
  return pi.tools[0];
}

describe("output extension — schema exposure", () => {
  beforeEach(() => {
    delete process.env.OUTPUT_SCHEMA;
  });

  it("uses generic object schema when OUTPUT_SCHEMA is not set", async () => {
    const tool = await importExtension(undefined);

    expect(tool.name).toBe("output");
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

  it("preserves required fields in tool parameter schema", async () => {
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
    expect(dataSchema.required).toEqual(["name", "age"]);
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
      properties: { orderId: { type: "string" } },
    };

    const tool = await importExtension(JSON.stringify(schema));

    const dataSchema = tool.parameters.properties.data;
    expect(dataSchema.description).toBe("Customer order summary");
  });

  it("adds default description when output schema has none", async () => {
    const schema = {
      type: "object",
      properties: { count: { type: "number" } },
    };

    const tool = await importExtension(JSON.stringify(schema));

    const dataSchema = tool.parameters.properties.data;
    expect(dataSchema.description).toBe("JSON object to return as the run output");
  });
});

describe("output extension — execute validation", () => {
  beforeEach(() => {
    delete process.env.OUTPUT_SCHEMA;
  });

  it("rejects empty data when required fields are declared", async () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const tool = await importExtension(JSON.stringify(schema));

    const result = await tool.execute("call-1", { data: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("validation failed");
    expect(result.content[0].text).toContain("name");
  });

  it("rejects type mismatches", async () => {
    const schema = {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    };
    const tool = await importExtension(JSON.stringify(schema));

    const result = await tool.execute("call-1", { data: { count: "not a number" } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("validation failed");
  });

  it("accepts valid data and emits output.emitted", async () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name", "age"],
    };
    const tool = await importExtension(JSON.stringify(schema));

    // Capture stdout to verify the emitted event
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: any) => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    try {
      const result = await tool.execute("call-1", { data: { name: "Ada", age: 36 } });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe("Output recorded");
      expect(result.details.data).toEqual({ name: "Ada", age: 36 });

      const emitted = writes
        .map((w) => {
          try {
            return JSON.parse(w);
          } catch {
            return null;
          }
        })
        .find((e) => e?.type === "output.emitted");
      expect(emitted).toBeTruthy();
      expect(emitted.data).toEqual({ name: "Ada", age: 36 });
    } finally {
      (process.stdout as any).write = originalWrite;
    }
  });

  it("accepts any data when OUTPUT_SCHEMA is not set", async () => {
    const tool = await importExtension(undefined);

    const result = await tool.execute("call-1", { data: {} });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Output recorded");
  });
});
