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
      skills: [{ id: "skill-a" }, { id: "skill-b" }],
      extensions: [{ id: "ext-1" }],
    });

    const result = assemblePayload(state);

    expect(Object.keys(result)).toEqual(["manifest", "prompt"]);
    expect(result).not.toHaveProperty("skillIds");
    expect(result).not.toHaveProperty("extensionIds");
  });

  test("includes skills in manifest.requires", () => {
    const state = makeState({
      skills: [{ id: "skill-a" }, { id: "skill-b" }],
    });

    const result = assemblePayload(state);
    const requires = result.manifest.requires as Record<string, unknown>;

    expect(requires.skills).toEqual(["skill-a", "skill-b"]);
  });

  test("includes extensions in manifest.requires", () => {
    const state = makeState({
      extensions: [{ id: "ext-1" }, { id: "ext-2" }],
    });

    const result = assemblePayload(state);
    const requires = result.manifest.requires as Record<string, unknown>;

    expect(requires.extensions).toEqual(["ext-1", "ext-2"]);
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

  test("preserves empty skills array when present in base manifest", () => {
    const state = makeState({
      skills: [],
      _manifestBase: {
        schemaVersion: "1.0",
        type: "flow",
        requires: { skills: [], services: [] },
      },
    });

    const result = assemblePayload(state);
    const requires = result.manifest.requires as Record<string, unknown>;

    expect(requires.skills).toEqual([]);
  });

  test("filters out empty skill/extension IDs", () => {
    const state = makeState({
      skills: [{ id: "skill-a" }, { id: "" }, { id: "skill-b" }],
      extensions: [{ id: "" }, { id: "ext-1" }],
    });

    const result = assemblePayload(state);
    const requires = result.manifest.requires as Record<string, unknown>;

    expect(requires.skills).toEqual(["skill-a", "skill-b"]);
    expect(requires.extensions).toEqual(["ext-1"]);
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

  test("includes services in manifest.requires", () => {
    const state = makeState({
      services: [{ id: "gmail", provider: "google-mail", scopes: [], connectionMode: "user" }],
    });

    const result = assemblePayload(state);
    const requires = result.manifest.requires as Record<string, unknown>;
    const services = requires.services as Array<Record<string, unknown>>;

    expect(services).toHaveLength(1);
    expect(services[0]!.id).toBe("gmail");
    expect(services[0]!.provider).toBe("google-mail");
  });

  test("filters out services without id or provider", () => {
    const state = makeState({
      services: [
        { id: "gmail", provider: "google-mail", scopes: [], connectionMode: "user" },
        { id: "", provider: "something", scopes: [], connectionMode: "user" },
        { id: "slack", provider: "", scopes: [], connectionMode: "user" },
      ],
    });

    const result = assemblePayload(state);
    const requires = result.manifest.requires as Record<string, unknown>;
    const services = requires.services as Array<Record<string, unknown>>;

    expect(services).toHaveLength(1);
    expect(services[0]!.id).toBe("gmail");
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
