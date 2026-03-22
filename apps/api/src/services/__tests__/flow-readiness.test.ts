import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { LoadedFlow } from "../../types/index.ts";
import { ApiError } from "../../lib/errors.ts";

// --- Mock state ---

let mockDepThrow: ApiError | null = null;
let mockConfigResult = { valid: true, errors: [] as { field: string; message: string }[] };
let mockManifestProviders: { id: string; provider: string }[] = [];

// --- Mocks (before dynamic import) ---

mock.module("../dependency-validation.ts", () => ({
  validateFlowDependencies: mock(async () => {
    if (mockDepThrow) throw mockDepThrow;
  }),
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
  schemaVersion: "1.0",
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
    tools: [],
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

async function expectApiError(fn: () => Promise<void>, code: string): Promise<ApiError> {
  try {
    await fn();
    throw new Error(`Expected ApiError with code '${code}' but no error was thrown`);
  } catch (err) {
    if (err instanceof ApiError) {
      expect(err.code).toBe(code);
      return err;
    }
    throw err;
  }
}

// --- Tests ---

beforeEach(() => {
  mockDepThrow = null;
  mockConfigResult = { valid: true, errors: [] };
  mockManifestProviders = [];
});

describe("validateFlowReadiness", () => {
  test("resolves when flow is valid", async () => {
    await validateFlowReadiness(makeParams());
  });

  // --- Empty prompt ---

  describe("empty prompt check", () => {
    test("throws empty_prompt for empty string", async () => {
      await expectApiError(
        () => validateFlowReadiness(makeParams({ flow: makeFlow({ prompt: "" }) })),
        "empty_prompt",
      );
    });

    test("throws empty_prompt for whitespace-only", async () => {
      await expectApiError(
        () => validateFlowReadiness(makeParams({ flow: makeFlow({ prompt: "   \n\t  " }) })),
        "empty_prompt",
      );
    });

    test("passes for non-empty prompt", async () => {
      await validateFlowReadiness(makeParams({ flow: makeFlow({ prompt: "Hello" }) }));
    });
  });

  // --- Missing skills ---

  describe("missing skills check", () => {
    test("throws missing_skill when required skill is not installed", async () => {
      const flow = makeFlow({
        manifest: makeManifest({
          dependencies: { skills: { "@test/skill-a": "^1.0.0" } },
        }),
        skills: [],
      });
      const err = await expectApiError(
        () => validateFlowReadiness(makeParams({ flow })),
        "missing_skill",
      );
      expect(err.message).toContain("@test/skill-a");
    });

    test("passes when required skill is installed", async () => {
      const flow = makeFlow({
        manifest: makeManifest({
          dependencies: { skills: { "@test/skill-a": "^1.0.0" } },
        }),
        skills: [{ id: "@test/skill-a", description: "Skill A" }],
      });
      await validateFlowReadiness(makeParams({ flow }));
    });

    test("throws for first missing skill when multiple required", async () => {
      const flow = makeFlow({
        manifest: makeManifest({
          dependencies: {
            skills: {
              "@test/skill-a": "^1.0.0",
              "@test/skill-b": "^1.0.0",
            },
          },
        }),
        skills: [{ id: "@test/skill-a", description: "Skill A" }],
      });
      const err = await expectApiError(
        () => validateFlowReadiness(makeParams({ flow })),
        "missing_skill",
      );
      expect(err.message).toContain("@test/skill-b");
    });
  });

  // --- Missing tools ---

  describe("missing tools check", () => {
    test("throws missing_tool when required tool is not installed", async () => {
      const flow = makeFlow({
        manifest: makeManifest({
          dependencies: { tools: { "@test/ext-a": "^1.0.0" } },
        }),
        tools: [],
      });
      const err = await expectApiError(
        () => validateFlowReadiness(makeParams({ flow })),
        "missing_tool",
      );
      expect(err.message).toContain("@test/ext-a");
    });

    test("passes when required tool is installed", async () => {
      const flow = makeFlow({
        manifest: makeManifest({
          dependencies: { tools: { "@test/ext-a": "^1.0.0" } },
        }),
        tools: [{ id: "@test/ext-a", description: "Ext A" }],
      });
      await validateFlowReadiness(makeParams({ flow }));
    });
  });

  // --- Provider dependencies ---

  describe("provider dependencies check", () => {
    test("throws when validateFlowDependencies throws", async () => {
      mockDepThrow = new ApiError({
        status: 400,
        code: "provider_not_enabled",
        title: "Provider Not Enabled",
        detail: "Provider 'gmail' is not configured",
      });
      await expectApiError(() => validateFlowReadiness(makeParams()), "provider_not_enabled");
    });

    test("passes when all providers are satisfied", async () => {
      mockDepThrow = null;
      await validateFlowReadiness(makeParams());
    });
  });

  // --- Config validation ---

  describe("config validation check", () => {
    test("throws config_incomplete when config fails validation", async () => {
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
      const err = await expectApiError(
        () => validateFlowReadiness(makeParams({ flow, config: {} })),
        "config_incomplete",
      );
      expect(err.message).toContain("apiKey");
    });

    test("skips config validation when config is not provided", async () => {
      mockConfigResult = {
        valid: false,
        errors: [{ field: "apiKey", message: "is required" }],
      };
      await validateFlowReadiness(makeParams());
    });

    test("passes when config is valid", async () => {
      mockConfigResult = { valid: true, errors: [] };
      await validateFlowReadiness(makeParams({ config: { apiKey: "abc" } }));
    });
  });

  // --- Fail-fast ordering ---

  describe("fail-fast ordering", () => {
    test("empty prompt takes priority over missing skills", async () => {
      const flow = makeFlow({
        prompt: "",
        manifest: makeManifest({
          dependencies: { skills: { "@test/skill-a": "^1.0.0" } },
        }),
        skills: [],
      });
      await expectApiError(() => validateFlowReadiness(makeParams({ flow })), "empty_prompt");
    });

    test("missing skill takes priority over missing tool", async () => {
      const flow = makeFlow({
        manifest: makeManifest({
          dependencies: {
            skills: { "@test/skill-a": "^1.0.0" },
            tools: { "@test/ext-a": "^1.0.0" },
          },
        }),
        skills: [],
        tools: [],
      });
      await expectApiError(() => validateFlowReadiness(makeParams({ flow })), "missing_skill");
    });

    test("missing tool takes priority over provider error", async () => {
      mockDepThrow = new ApiError({
        status: 400,
        code: "provider_not_enabled",
        title: "Provider Not Enabled",
        detail: "Provider 'gmail' is not configured",
      });
      const flow = makeFlow({
        manifest: makeManifest({
          dependencies: { tools: { "@test/ext-a": "^1.0.0" } },
        }),
        tools: [],
      });
      await expectApiError(() => validateFlowReadiness(makeParams({ flow })), "missing_tool");
    });

    test("provider error takes priority over config error", async () => {
      mockDepThrow = new ApiError({
        status: 400,
        code: "dependency_not_satisfied",
        title: "Dependency Not Satisfied",
        detail: "Provider 'gmail' is not connected",
      });
      mockConfigResult = {
        valid: false,
        errors: [{ field: "apiKey", message: "is required" }],
      };
      await expectApiError(
        () => validateFlowReadiness(makeParams({ config: {} })),
        "dependency_not_satisfied",
      );
    });
  });
});
