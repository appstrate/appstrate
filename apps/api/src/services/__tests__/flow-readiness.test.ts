import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { LoadedFlow } from "../../types/index.ts";
import type { DependencyError } from "../dependency-validation.ts";

// --- Mock state ---

let mockDepError: DependencyError | null = null;
let mockConfigResult = { valid: true, errors: [] as { field: string; message: string }[] };
let mockManifestProviders: { id: string; provider: string }[] = [];

// --- Mocks (before dynamic import) ---

mock.module("../dependency-validation.ts", () => ({
  validateFlowDependencies: mock(async () => mockDepError),
}));

mock.module("../schema.ts", () => ({
  validateConfig: mock(() => mockConfigResult),
}));

mock.module("../../lib/manifest-utils.ts", () => ({
  resolveManifestProviders: mock(() => mockManifestProviders),
}));

// --- Dynamic import ---

const { validateFlowReadiness } = await import("../flow-readiness.ts");

// --- Helpers ---

const BASE_MANIFEST = {
  name: "my-flow",
  version: "1.0.0",
  type: "flow" as const,
  displayName: "My Flow",
  schemaVersion: "1",
  author: "test",
};

function makeManifest(overrides: Record<string, unknown> = {}): LoadedFlow["manifest"] {
  return { ...BASE_MANIFEST, ...overrides } as unknown as LoadedFlow["manifest"];
}

function makeFlow(overrides: Partial<LoadedFlow> = {}): LoadedFlow {
  return {
    id: "@test/my-flow",
    prompt: "Do something useful",
    skills: [],
    extensions: [],
    source: "local",
    manifest: makeManifest(),
    ...overrides,
  };
}

function makeParams(overrides: Partial<Parameters<typeof validateFlowReadiness>[0]> = {}) {
  return {
    flow: makeFlow(),
    providerProfiles: {},
    orgId: "org-1",
    ...overrides,
  };
}

// --- Tests ---

beforeEach(() => {
  mockDepError = null;
  mockConfigResult = { valid: true, errors: [] };
  mockManifestProviders = [];
});

describe("validateFlowReadiness", () => {
  test("returns null when flow is valid", async () => {
    const result = await validateFlowReadiness(makeParams());
    expect(result).toBeNull();
  });

  // --- Empty prompt ---

  describe("empty prompt check", () => {
    test("returns EMPTY_PROMPT for empty string", async () => {
      const result = await validateFlowReadiness(makeParams({ flow: makeFlow({ prompt: "" }) }));
      expect(result).not.toBeNull();
      expect(result!.error).toBe("EMPTY_PROMPT");
    });

    test("returns EMPTY_PROMPT for whitespace-only", async () => {
      const result = await validateFlowReadiness(
        makeParams({ flow: makeFlow({ prompt: "   \n\t  " }) }),
      );
      expect(result).not.toBeNull();
      expect(result!.error).toBe("EMPTY_PROMPT");
    });

    test("passes for non-empty prompt", async () => {
      const result = await validateFlowReadiness(
        makeParams({ flow: makeFlow({ prompt: "Hello" }) }),
      );
      expect(result).toBeNull();
    });
  });

  // --- Missing skills ---

  describe("missing skills check", () => {
    test("returns MISSING_SKILL when required skill is not installed", async () => {
      const flow = makeFlow({
        manifest: makeManifest({
          requires: { skills: { "@test/skill-a": "^1.0.0" } },
        }),
        skills: [],
      });
      const result = await validateFlowReadiness(makeParams({ flow }));
      expect(result).not.toBeNull();
      expect(result!.error).toBe("MISSING_SKILL");
      expect(result!.message).toContain("@test/skill-a");
    });

    test("passes when required skill is installed", async () => {
      const flow = makeFlow({
        manifest: makeManifest({
          requires: { skills: { "@test/skill-a": "^1.0.0" } },
        }),
        skills: [{ id: "@test/skill-a", description: "Skill A" }],
      });
      const result = await validateFlowReadiness(makeParams({ flow }));
      expect(result).toBeNull();
    });

    test("returns error for first missing skill when multiple required", async () => {
      const flow = makeFlow({
        manifest: makeManifest({
          requires: {
            skills: {
              "@test/skill-a": "^1.0.0",
              "@test/skill-b": "^1.0.0",
            },
          },
        }),
        skills: [{ id: "@test/skill-a", description: "Skill A" }],
      });
      const result = await validateFlowReadiness(makeParams({ flow }));
      expect(result).not.toBeNull();
      expect(result!.error).toBe("MISSING_SKILL");
      expect(result!.message).toContain("@test/skill-b");
    });
  });

  // --- Missing extensions ---

  describe("missing extensions check", () => {
    test("returns MISSING_EXTENSION when required extension is not installed", async () => {
      const flow = makeFlow({
        manifest: makeManifest({
          requires: { extensions: { "@test/ext-a": "^1.0.0" } },
        }),
        extensions: [],
      });
      const result = await validateFlowReadiness(makeParams({ flow }));
      expect(result).not.toBeNull();
      expect(result!.error).toBe("MISSING_EXTENSION");
      expect(result!.message).toContain("@test/ext-a");
    });

    test("passes when required extension is installed", async () => {
      const flow = makeFlow({
        manifest: makeManifest({
          requires: { extensions: { "@test/ext-a": "^1.0.0" } },
        }),
        extensions: [{ id: "@test/ext-a", description: "Ext A" }],
      });
      const result = await validateFlowReadiness(makeParams({ flow }));
      expect(result).toBeNull();
    });
  });

  // --- Provider dependencies ---

  describe("provider dependencies check", () => {
    test("returns dependency error when validateFlowDependencies fails", async () => {
      mockDepError = {
        error: "PROVIDER_NOT_ENABLED",
        message: "Provider 'gmail' is not configured",
        providerId: "gmail",
      };
      const result = await validateFlowReadiness(makeParams());
      expect(result).not.toBeNull();
      expect(result!.error).toBe("PROVIDER_NOT_ENABLED");
    });

    test("passes when all providers are satisfied", async () => {
      mockDepError = null;
      const result = await validateFlowReadiness(makeParams());
      expect(result).toBeNull();
    });
  });

  // --- Config validation ---

  describe("config validation check", () => {
    test("returns CONFIG_INCOMPLETE when config fails validation", async () => {
      mockConfigResult = {
        valid: false,
        errors: [{ field: "apiKey", message: "is required" }],
      };
      const flow = makeFlow({
        manifest: makeManifest({
          config: {
            schema: {
              type: "object",
              properties: { apiKey: { type: "string" } },
              required: ["apiKey"],
            },
          },
        }),
      });
      const result = await validateFlowReadiness(makeParams({ flow, config: {} }));
      expect(result).not.toBeNull();
      expect(result!.error).toBe("CONFIG_INCOMPLETE");
      expect(result!.message).toContain("apiKey");
      expect(result!.configUrl).toBe("/api/flows/@test/my-flow/config");
    });

    test("skips config validation when config is not provided", async () => {
      mockConfigResult = {
        valid: false,
        errors: [{ field: "apiKey", message: "is required" }],
      };
      const result = await validateFlowReadiness(makeParams());
      expect(result).toBeNull();
    });

    test("passes when config is valid", async () => {
      mockConfigResult = { valid: true, errors: [] };
      const result = await validateFlowReadiness(makeParams({ config: { apiKey: "abc" } }));
      expect(result).toBeNull();
    });
  });

  // --- Fail-fast ordering ---

  describe("fail-fast ordering", () => {
    test("empty prompt takes priority over missing skills", async () => {
      const flow = makeFlow({
        prompt: "",
        manifest: makeManifest({
          requires: { skills: { "@test/skill-a": "^1.0.0" } },
        }),
        skills: [],
      });
      const result = await validateFlowReadiness(makeParams({ flow }));
      expect(result!.error).toBe("EMPTY_PROMPT");
    });

    test("missing skill takes priority over missing extension", async () => {
      const flow = makeFlow({
        manifest: makeManifest({
          requires: {
            skills: { "@test/skill-a": "^1.0.0" },
            extensions: { "@test/ext-a": "^1.0.0" },
          },
        }),
        skills: [],
        extensions: [],
      });
      const result = await validateFlowReadiness(makeParams({ flow }));
      expect(result!.error).toBe("MISSING_SKILL");
    });

    test("missing extension takes priority over provider error", async () => {
      mockDepError = {
        error: "PROVIDER_NOT_ENABLED",
        message: "Provider 'gmail' is not configured",
        providerId: "gmail",
      };
      const flow = makeFlow({
        manifest: makeManifest({
          requires: { extensions: { "@test/ext-a": "^1.0.0" } },
        }),
        extensions: [],
      });
      const result = await validateFlowReadiness(makeParams({ flow }));
      expect(result!.error).toBe("MISSING_EXTENSION");
    });

    test("provider error takes priority over config error", async () => {
      mockDepError = {
        error: "DEPENDENCY_NOT_SATISFIED",
        message: "Provider 'gmail' is not connected",
        providerId: "gmail",
      };
      mockConfigResult = {
        valid: false,
        errors: [{ field: "apiKey", message: "is required" }],
      };
      const result = await validateFlowReadiness(makeParams({ config: {} }));
      expect(result!.error).toBe("DEPENDENCY_NOT_SATISFIED");
    });
  });
});
