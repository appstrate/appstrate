// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  buildRuntimeToolDefs,
  RUNTIME_TOOL_EVENTS_META_KEY,
  type RuntimeToolEvent,
} from "@appstrate/core/runtime-tool-defs";

/**
 * Tests for the `output` runtime tool — now a transport-neutral MCP tool
 * definition (`@appstrate/core/runtime-tool-defs`) rather than a Pi-SDK
 * extension. The output JSON Schema is passed explicitly (no longer read
 * from `process.env.OUTPUT_SCHEMA`): the schema is advertised as the `data`
 * argument's input schema AND is AJV-validated at call time. The call
 * returns its canonical `output.emitted` event under the result `_meta`
 * key for the host to re-emit into the run sink.
 */

function outputDef(outputSchema?: Record<string, unknown>) {
  const def = buildRuntimeToolDefs({
    runtimeTools: ["output"],
    ...(outputSchema !== undefined ? { outputSchema } : {}),
  })[0];
  if (!def) throw new Error("output def not built");
  return def;
}

function eventsOf(meta: Record<string, unknown> | undefined): RuntimeToolEvent[] {
  const raw = meta?.[RUNTIME_TOOL_EVENTS_META_KEY];
  return Array.isArray(raw) ? (raw as RuntimeToolEvent[]) : [];
}

describe("output runtime tool — schema exposure", () => {
  it("uses generic object schema when no output schema is provided", () => {
    const def = outputDef();
    expect(def.descriptor.name).toBe("output");
    const dataSchema = (def.descriptor.inputSchema.properties as Record<string, any>).data;
    expect(dataSchema.type).toBe("object");
    expect(dataSchema.properties).toBeUndefined();
  });

  it("injects output schema properties when provided", () => {
    const schema = {
      type: "object",
      properties: {
        total: { type: "number", description: "Total count" },
        items: { type: "array", items: { type: "string" } },
      },
      required: ["total", "items"],
    };
    const def = outputDef(schema);
    const dataSchema = (def.descriptor.inputSchema.properties as Record<string, any>).data;
    expect(dataSchema.type).toBe("object");
    expect(dataSchema.properties.total.type).toBe("number");
    expect(dataSchema.properties.items.type).toBe("array");
    expect(dataSchema.required).toEqual(["total", "items"]);
  });

  it("preserves the output schema description, defaulting when absent", () => {
    const withDesc = outputDef({
      type: "object",
      description: "Customer order summary",
      properties: { orderId: { type: "string" } },
    });
    expect(
      (withDesc.descriptor.inputSchema.properties as Record<string, any>).data.description,
    ).toBe("Customer order summary");

    const noDesc = outputDef({ type: "object", properties: { count: { type: "number" } } });
    expect((noDesc.descriptor.inputSchema.properties as Record<string, any>).data.description).toBe(
      "JSON object to return as the run output",
    );
  });

  it("makes the tool description mandatory-iff-schema (call contract)", () => {
    // No declared output schema → calling `output` is optional (a
    // side-effect-only run is a valid success).
    expect(outputDef().descriptor.description).toContain("Optional");
    // A declared output schema → the agent MUST call it exactly once.
    const withSchema = outputDef({ type: "object", properties: { ok: { type: "boolean" } } });
    expect(withSchema.descriptor.description).toContain("Call exactly once");
  });
});

describe("output runtime tool — execute validation", () => {
  it("rejects empty data when required fields are declared", async () => {
    const def = outputDef({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    const result = await def.handler({ data: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("validation failed");
    expect(result.content[0]!.text).toContain("name");
    expect(eventsOf(result._meta)).toHaveLength(0);
  });

  it("rejects type mismatches", async () => {
    const def = outputDef({
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    });
    const result = await def.handler({ data: { count: "not a number" } });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("validation failed");
  });

  it("accepts valid data and returns an output.emitted event", async () => {
    const def = outputDef({
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name", "age"],
    });
    const result = await def.handler({ data: { name: "Ada", age: 36 } });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("Output recorded");
    const events = eventsOf(result._meta);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("output.emitted");
    expect(events[0]!.data).toEqual({ name: "Ada", age: 36 });
  });

  it("accepts any data when no output schema is provided", async () => {
    const def = outputDef();
    const result = await def.handler({ data: { whatever: true } });
    expect(result.isError).toBeUndefined();
    expect(eventsOf(result._meta)[0]!.type).toBe("output.emitted");
  });
});
