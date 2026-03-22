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
      keywords: [],
    },
    prompt: "Do something useful",
    providers: [],
    skills: [],
    tools: [],
    inputSchema: [],
    outputSchema: [],
    configSchema: [],
    execution: { timeout: 300, outputRetries: 2, logs: true },
    _manifestBase: { schemaVersion: "1.0", type: "flow" },
    ...overrides,
  };
}

// --- Tests ---

describe("assemblePayload", () => {
  test("returns only manifest and prompt (no skillIds/toolIds)", () => {
    const state = makeState({
      skills: [
        { id: "@my-org/skill-a", version: "1.0.0" },
        { id: "@my-org/skill-b", version: "2.0.0" },
      ],
      tools: [{ id: "@my-org/ext-1", version: "0.1.0" }],
    });

    const result = assemblePayload(state);

    expect(Object.keys(result)).toEqual(["manifest", "prompt"]);
    expect(result).not.toHaveProperty("skillIds");
    expect(result).not.toHaveProperty("toolIds");
  });

  test("includes skills in manifest.dependencies as record", () => {
    const state = makeState({
      skills: [
        { id: "@my-org/skill-a", version: "1.0.0" },
        { id: "@my-org/skill-b", version: "2.0.0" },
      ],
    });

    const result = assemblePayload(state);
    const deps = result.manifest.dependencies as Record<string, unknown>;

    expect(deps.skills).toEqual({ "@my-org/skill-a": "1.0.0", "@my-org/skill-b": "2.0.0" });
  });

  test("includes tools in manifest.dependencies as record", () => {
    const state = makeState({
      tools: [
        { id: "@my-org/ext-1", version: "0.1.0" },
        { id: "@my-org/ext-2", version: "1.0.0" },
      ],
    });

    const result = assemblePayload(state);
    const deps = result.manifest.dependencies as Record<string, unknown>;

    expect(deps.tools).toEqual({ "@my-org/ext-1": "0.1.0", "@my-org/ext-2": "1.0.0" });
  });

  test("omits skills from manifest.dependencies when empty and not in base", () => {
    const state = makeState({ skills: [] });

    const result = assemblePayload(state);
    const deps = result.manifest.dependencies as Record<string, unknown>;

    expect(deps).not.toHaveProperty("skills");
  });

  test("omits tools from manifest.dependencies when empty and not in base", () => {
    const state = makeState({ tools: [] });

    const result = assemblePayload(state);
    const deps = result.manifest.dependencies as Record<string, unknown>;

    expect(deps).not.toHaveProperty("tools");
  });

  test("preserves empty skills object when present in base manifest", () => {
    const state = makeState({
      skills: [],
      _manifestBase: {
        schemaVersion: "1.0",
        type: "flow",
        dependencies: { skills: {}, providers: {} },
      },
    });

    const result = assemblePayload(state);
    const deps = result.manifest.dependencies as Record<string, unknown>;

    expect(deps.skills).toEqual({});
  });

  test("filters out empty skill/tool IDs", () => {
    const state = makeState({
      skills: [
        { id: "@my-org/skill-a", version: "1.0.0" },
        { id: "", version: "*" },
        { id: "@my-org/skill-b", version: "2.0.0" },
      ],
      tools: [
        { id: "", version: "*" },
        { id: "@my-org/ext-1", version: "0.1.0" },
      ],
    });

    const result = assemblePayload(state);
    const deps = result.manifest.dependencies as Record<string, unknown>;

    expect(deps.skills).toEqual({ "@my-org/skill-a": "1.0.0", "@my-org/skill-b": "2.0.0" });
    expect(deps.tools).toEqual({ "@my-org/ext-1": "0.1.0" });
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

  test("includes providers in manifest.dependencies as record", () => {
    const state = makeState({
      providers: [{ id: "@my-org/gmail", version: "1.0.0", scopes: [], connectionMode: "user" }],
    });

    const result = assemblePayload(state);
    const deps = result.manifest.dependencies as Record<string, unknown>;
    const providers = deps.providers as Record<string, string>;

    expect(providers).toEqual({ "@my-org/gmail": "1.0.0" });
  });

  test("filters out providers without id", () => {
    const state = makeState({
      providers: [
        { id: "@my-org/gmail", version: "1.0.0", scopes: [], connectionMode: "user" },
        { id: "", version: "*", scopes: [], connectionMode: "user" },
      ],
    });

    const result = assemblePayload(state);
    const deps = result.manifest.dependencies as Record<string, unknown>;
    const providers = deps.providers as Record<string, string>;

    expect(Object.keys(providers)).toHaveLength(1);
    expect(providers["@my-org/gmail"]).toBe("1.0.0");
  });

  test("writes providersConfiguration for non-default config", () => {
    const state = makeState({
      providers: [
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
    const provCfg = result.manifest.providersConfiguration as Record<
      string,
      Record<string, unknown>
    >;

    expect(provCfg["@my-org/gmail"]).toEqual({
      scopes: ["gmail.readonly"],
      connectionMode: "admin",
    });
    expect(provCfg["@my-org/slack"]).toBeUndefined(); // default values, no config needed
  });

  test("omits timeout and outputRetries when defaults and not in base", () => {
    const state = makeState({
      execution: { timeout: 300, outputRetries: 2, logs: true },
    });

    const result = assemblePayload(state);

    expect(result.manifest).not.toHaveProperty("timeout");
    expect(result.manifest).not.toHaveProperty("x-outputRetries");
  });

  test("includes timeout and outputRetries when values differ from defaults", () => {
    const state = makeState({
      execution: { timeout: 600, outputRetries: 3, logs: true },
    });

    const result = assemblePayload(state);

    expect(result.manifest.timeout).toBe(600);
    expect(result.manifest["x-outputRetries"]).toBe(3);
  });

  test("preserves timeout and outputRetries when present in base manifest", () => {
    const state = makeState({
      execution: { timeout: 300, outputRetries: 2, logs: true },
      _manifestBase: {
        schemaVersion: "1.0",
        type: "flow",
        timeout: 300,
        "x-outputRetries": 2,
      },
    });

    const result = assemblePayload(state);

    expect(result.manifest.timeout).toBe(300);
    expect(result.manifest["x-outputRetries"]).toBe(2);
  });
});
