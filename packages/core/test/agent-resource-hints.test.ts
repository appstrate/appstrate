// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  AGENT_RESOURCES_META_KEY,
  agentManifestSchema,
  getAgentResourceHints,
  validateManifest,
} from "../src/validation.ts";

function validAgentManifest(overrides?: Record<string, unknown>) {
  return {
    name: "@test/resource-agent",
    version: "1.0.0",
    type: "agent",
    schema_version: "0.1",
    display_name: "Resource Agent",
    author: "test",
    ...overrides,
  };
}

function resourceMeta(value: unknown): Record<string, unknown> {
  return { [AGENT_RESOURCES_META_KEY]: value };
}

function parseAgent(overrides?: Record<string, unknown>) {
  const result = validateManifest(validAgentManifest(overrides));
  expect(result.valid).toBe(true);
  if (!result.valid) throw new Error(result.errors.join("\n"));
  return result.manifest;
}

function expectResourceError(
  value: unknown,
  expectedPath: Array<string | number>,
  expectedMessage: string,
): void {
  const result = agentManifestSchema.safeParse(validAgentManifest({ _meta: resourceMeta(value) }));
  expect(result.success).toBe(false);
  if (result.success) return;

  expect(
    result.error.issues.some(
      (issue) =>
        JSON.stringify(issue.path) === JSON.stringify(expectedPath) &&
        issue.message.includes(expectedMessage),
    ),
  ).toBe(true);
}

describe("agent resource hints", () => {
  it("returns undefined when the extension is absent", () => {
    expect(getAgentResourceHints(parseAgent())).toBeUndefined();
  });

  it("accepts a memory-only hint", () => {
    const manifest = parseAgent({
      _meta: resourceMeta({ memory_mb: 2048 }),
    });

    expect(getAgentResourceHints(manifest)).toEqual({ memoryMb: 2048 });
  });

  it("accepts a CPU-only hint", () => {
    const manifest = parseAgent({
      _meta: resourceMeta({ cpu: 4 }),
    });

    expect(getAgentResourceHints(manifest)).toEqual({ cpu: 4 });
  });

  it("accepts both hints", () => {
    const manifest = parseAgent({
      _meta: resourceMeta({ memory_mb: 4096, cpu: 6 }),
    });

    expect(getAgentResourceHints(manifest)).toEqual({ memoryMb: 4096, cpu: 6 });
  });

  it("preserves unrelated valid _meta namespaces", () => {
    const unknownMeta = { future: { enabled: true } };
    const manifest = parseAgent({
      _meta: {
        "com.example/future": unknownMeta,
        [AGENT_RESOURCES_META_KEY]: { cpu: 3 },
      },
    });

    expect(manifest._meta?.["com.example/future"]).toEqual(unknownMeta);
    expect(getAgentResourceHints(manifest)).toEqual({ cpu: 3 });
  });

  it("does not apply the agent-only contract to other package types", () => {
    const result = validateManifest({
      name: "@test/resource-skill",
      version: "1.0.0",
      type: "skill",
      _meta: resourceMeta({ memory_mb: -1, future_field: true }),
    });

    expect(result.valid).toBe(true);
  });

  it("rejects an empty resource hint object", () => {
    expectResourceError(
      {},
      ["_meta", AGENT_RESOURCES_META_KEY],
      "At least one of memory_mb or cpu",
    );
  });

  it("rejects unknown members", () => {
    expectResourceError(
      { cpu: 2, disk_mb: 1024 },
      ["_meta", AGENT_RESOURCES_META_KEY, "disk_mb"],
      'Unknown agent resource hint "disk_mb"',
    );
  });

  it("rejects non-object values", () => {
    expectResourceError("cpu=2", ["_meta", AGENT_RESOURCES_META_KEY], "expected record");
  });

  for (const [field, value] of [
    ["memory_mb", 0],
    ["memory_mb", -1],
    ["cpu", 0],
    ["cpu", -1],
  ] as const) {
    it(`rejects ${field}=${value}`, () => {
      expectResourceError(
        { [field]: value },
        ["_meta", AGENT_RESOURCES_META_KEY, field],
        `${field} must be a positive safe integer`,
      );
    });
  }

  for (const field of ["memory_mb", "cpu"] as const) {
    it(`rejects a fractional ${field}`, () => {
      expectResourceError(
        { [field]: 1.5 },
        ["_meta", AGENT_RESOURCES_META_KEY, field],
        `${field} must be a positive safe integer`,
      );
    });

    it(`rejects an unsafe ${field}`, () => {
      expectResourceError(
        { [field]: Number.MAX_SAFE_INTEGER + 1 },
        ["_meta", AGENT_RESOURCES_META_KEY, field],
        `${field} must be a positive safe integer`,
      );
    });
  }
});
