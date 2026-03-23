import { describe, it, expect } from "bun:test";
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
    execution: { timeout: 300, logs: true, outputMode: "report" },
    _manifestBase: { schemaVersion: "1.0", type: "flow" },
    ...overrides,
  };
}

// --- Tests ---

describe("assemblePayload", () => {
  it("returns only manifest and prompt (no skillIds/toolIds)", () => {
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

  it("includes skills in manifest.dependencies as record", () => {
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

  it("includes tools in manifest.dependencies as record", () => {
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

  it("omits skills from manifest.dependencies when empty and not in base", () => {
    const state = makeState({ skills: [] });

    const result = assemblePayload(state);
    const deps = result.manifest.dependencies as Record<string, unknown>;

    expect(deps).not.toHaveProperty("skills");
  });

  it("omits tools from manifest.dependencies when empty and not in base", () => {
    const state = makeState({ tools: [] });

    const result = assemblePayload(state);
    const deps = result.manifest.dependencies as Record<string, unknown>;

    expect(deps).not.toHaveProperty("tools");
  });

  it("preserves empty skills object when present in base manifest", () => {
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

  it("filters out empty skill/tool IDs", () => {
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

  it("builds correct manifest name from scope and id", () => {
    const state = makeState();

    const result = assemblePayload(state);

    expect(result.manifest.name).toBe("@my-org/test-flow");
  });

  it("passes prompt through", () => {
    const state = makeState({ prompt: "My custom prompt" });

    const result = assemblePayload(state);

    expect(result.prompt).toBe("My custom prompt");
  });

  it("includes providers in manifest.dependencies as record", () => {
    const state = makeState({
      providers: [{ id: "@my-org/gmail", version: "1.0.0", scopes: [], connectionMode: "user" }],
    });

    const result = assemblePayload(state);
    const deps = result.manifest.dependencies as Record<string, unknown>;
    const providers = deps.providers as Record<string, string>;

    expect(providers).toEqual({ "@my-org/gmail": "1.0.0" });
  });

  it("filters out providers without id", () => {
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

  it("writes providersConfiguration for non-default config", () => {
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

  it("omits timeout when default and not in base", () => {
    const state = makeState({
      execution: { timeout: 300, logs: true, outputMode: "report" },
    });

    const result = assemblePayload(state);

    expect(result.manifest).not.toHaveProperty("timeout");
  });

  it("includes timeout when value differs from default", () => {
    const state = makeState({
      execution: { timeout: 600, logs: true, outputMode: "report" },
    });

    const result = assemblePayload(state);

    expect(result.manifest.timeout).toBe(600);
  });

  it("preserves timeout when present in base manifest", () => {
    const state = makeState({
      execution: { timeout: 300, logs: true, outputMode: "report" },
      _manifestBase: {
        schemaVersion: "1.0",
        type: "flow",
        timeout: 300,
      },
    });

    const result = assemblePayload(state);

    expect(result.manifest.timeout).toBe(300);
  });

  it("writes x-output-mode data to manifest when output schema present", () => {
    const state = makeState({
      execution: { timeout: 300, logs: true, outputMode: "data" },
      outputSchema: [
        { _id: "1", key: "result", type: "string", description: "The result", required: true },
      ],
    });

    const result = assemblePayload(state);

    expect(result.manifest["x-output-mode"]).toBe("data");
  });

  it("writes x-output-mode report to manifest", () => {
    const state = makeState({
      execution: { timeout: 300, logs: true, outputMode: "report" },
    });

    const result = assemblePayload(state);

    expect(result.manifest["x-output-mode"]).toBe("report");
  });

  it("falls back to report when data mode has no output schema", () => {
    const state = makeState({
      execution: { timeout: 300, logs: true, outputMode: "data" },
      outputSchema: [],
    });

    const result = assemblePayload(state);

    expect(result.manifest["x-output-mode"]).toBe("report");
  });

  it("falls back to report when data mode has only empty output schema keys", () => {
    const state = makeState({
      execution: { timeout: 300, logs: true, outputMode: "data" },
      outputSchema: [{ _id: "1", key: "", type: "string", description: "", required: false }],
    });

    const result = assemblePayload(state);

    expect(result.manifest["x-output-mode"]).toBe("report");
  });

  it("keeps data mode when output schema has fields", () => {
    const state = makeState({
      execution: { timeout: 300, logs: true, outputMode: "data" },
      outputSchema: [
        { _id: "1", key: "result", type: "string", description: "The result", required: true },
      ],
    });

    const result = assemblePayload(state);

    expect(result.manifest["x-output-mode"]).toBe("data");
  });

  it("strips legacy x-outputRetries from base manifest", () => {
    const state = makeState({
      _manifestBase: {
        schemaVersion: "1.0",
        type: "flow",
        "x-outputRetries": 2,
      },
    });

    const result = assemblePayload(state);

    expect(result.manifest).not.toHaveProperty("x-outputRetries");
  });
});
