import { describe, test, expect } from "bun:test";
import { assemblePayload } from "../utils";
import type { FlowFormState } from "../types";

// --- Helpers ---

function makeState(overrides: Partial<FlowFormState> = {}): FlowFormState {
  return {
    metadata: {
      id: "test-flow",
      scope: "my-org",
      version: "1.0.0",
      displayName: "Test Flow",
      description: "A test flow",
      author: "test@test.com",
      tags: [],
    },
    prompt: "Do something useful",
    services: [],
    skills: [],
    extensions: [],
    inputSchema: [],
    outputSchema: [],
    configSchema: [],
    execution: { timeout: 300, outputRetries: 2 },
    _manifestBase: { schemaVersion: "1.0", type: "flow" },
    ...overrides,
  };
}

// --- Tests ---

describe("assemblePayload", () => {
  test("returns only manifest and prompt (no skillIds/extensionIds)", () => {
    const state = makeState({
      skills: [
        { id: "@my-org/skill-a", version: "1.0.0" },
        { id: "@my-org/skill-b", version: "2.0.0" },
      ],
      extensions: [{ id: "@my-org/ext-1", version: "0.1.0" }],
    });

    const result = assemblePayload(state);

    expect(Object.keys(result)).toEqual(["manifest", "prompt"]);
    expect(result).not.toHaveProperty("skillIds");
    expect(result).not.toHaveProperty("extensionIds");
  });

  test("includes skills in manifest.requires as record", () => {
    const state = makeState({
      skills: [
        { id: "@my-org/skill-a", version: "1.0.0" },
        { id: "@my-org/skill-b", version: "2.0.0" },
      ],
    });

    const result = assemblePayload(state);
    const requires = result.manifest.requires as Record<string, unknown>;

    expect(requires.skills).toEqual({ "@my-org/skill-a": "1.0.0", "@my-org/skill-b": "2.0.0" });
  });

  test("includes extensions in manifest.requires as record", () => {
    const state = makeState({
      extensions: [
        { id: "@my-org/ext-1", version: "0.1.0" },
        { id: "@my-org/ext-2", version: "1.0.0" },
      ],
    });

    const result = assemblePayload(state);
    const requires = result.manifest.requires as Record<string, unknown>;

    expect(requires.extensions).toEqual({ "@my-org/ext-1": "0.1.0", "@my-org/ext-2": "1.0.0" });
  });

  test("omits skills from manifest.requires when empty and not in base", () => {
    const state = makeState({ skills: [] });

    const result = assemblePayload(state);
    const requires = result.manifest.requires as Record<string, unknown>;

    expect(requires).not.toHaveProperty("skills");
  });

  test("omits extensions from manifest.requires when empty and not in base", () => {
    const state = makeState({ extensions: [] });

    const result = assemblePayload(state);
    const requires = result.manifest.requires as Record<string, unknown>;

    expect(requires).not.toHaveProperty("extensions");
  });

  test("preserves empty skills object when present in base manifest", () => {
    const state = makeState({
      skills: [],
      _manifestBase: {
        schemaVersion: "1.0",
        type: "flow",
        requires: { skills: {}, services: {} },
      },
    });

    const result = assemblePayload(state);
    const requires = result.manifest.requires as Record<string, unknown>;

    expect(requires.skills).toEqual({});
  });

  test("filters out empty skill/extension IDs", () => {
    const state = makeState({
      skills: [
        { id: "@my-org/skill-a", version: "1.0.0" },
        { id: "", version: "*" },
        { id: "@my-org/skill-b", version: "2.0.0" },
      ],
      extensions: [
        { id: "", version: "*" },
        { id: "@my-org/ext-1", version: "0.1.0" },
      ],
    });

    const result = assemblePayload(state);
    const requires = result.manifest.requires as Record<string, unknown>;

    expect(requires.skills).toEqual({ "@my-org/skill-a": "1.0.0", "@my-org/skill-b": "2.0.0" });
    expect(requires.extensions).toEqual({ "@my-org/ext-1": "0.1.0" });
  });

  test("builds correct manifest name from scope and id", () => {
    const state = makeState();

    const result = assemblePayload(state);

    expect(result.manifest.name).toBe("@my-org/test-flow");
  });

  test("passes prompt through", () => {
    const state = makeState({ prompt: "My custom prompt" });

    const result = assemblePayload(state);

    expect(result.prompt).toBe("My custom prompt");
  });

  test("includes services in manifest.requires as record", () => {
    const state = makeState({
      services: [{ id: "@my-org/gmail", version: "1.0.0", scopes: [], connectionMode: "user" }],
    });

    const result = assemblePayload(state);
    const requires = result.manifest.requires as Record<string, unknown>;
    const services = requires.services as Record<string, string>;

    expect(services).toEqual({ "@my-org/gmail": "1.0.0" });
  });

  test("filters out services without id", () => {
    const state = makeState({
      services: [
        { id: "@my-org/gmail", version: "1.0.0", scopes: [], connectionMode: "user" },
        { id: "", version: "*", scopes: [], connectionMode: "user" },
      ],
    });

    const result = assemblePayload(state);
    const requires = result.manifest.requires as Record<string, unknown>;
    const services = requires.services as Record<string, string>;

    expect(Object.keys(services)).toHaveLength(1);
    expect(services["@my-org/gmail"]).toBe("1.0.0");
  });

  test("writes servicesConfiguration for non-default config", () => {
    const state = makeState({
      services: [
        {
          id: "@my-org/gmail",
          version: "1.0.0",
          scopes: ["gmail.readonly"],
          connectionMode: "admin",
        },
        { id: "@my-org/slack", version: "2.0.0", scopes: [], connectionMode: "user" },
      ],
    });

    const result = assemblePayload(state);
    const svcCfg = result.manifest.servicesConfiguration as Record<string, Record<string, unknown>>;

    expect(svcCfg["@my-org/gmail"]).toEqual({
      scopes: ["gmail.readonly"],
      connectionMode: "admin",
    });
    expect(svcCfg["@my-org/slack"]).toBeUndefined(); // default values, no config needed
  });

  test("omits execution when defaults and not in base", () => {
    const state = makeState({
      execution: { timeout: 300, outputRetries: 2 },
    });

    const result = assemblePayload(state);

    expect(result.manifest).not.toHaveProperty("execution");
  });

  test("includes execution when values differ from defaults", () => {
    const state = makeState({
      execution: { timeout: 600, outputRetries: 3 },
    });

    const result = assemblePayload(state);

    expect(result.manifest.execution).toEqual({ timeout: 600, outputRetries: 3 });
  });

  test("preserves execution when present in base manifest", () => {
    const state = makeState({
      execution: { timeout: 300, outputRetries: 2 },
      _manifestBase: {
        schemaVersion: "1.0",
        type: "flow",
        execution: { timeout: 300, outputRetries: 2, maxTokens: 4096 },
      },
    });

    const result = assemblePayload(state);
    const execution = result.manifest.execution as Record<string, unknown>;

    expect(execution.timeout).toBe(300);
    expect(execution.maxTokens).toBe(4096);
  });
});
