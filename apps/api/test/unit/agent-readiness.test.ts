// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for agent-readiness.
 *
 * Focus: validateAgentReadiness (throwing) must delegate to
 * collectAgentReadinessErrors (collector) with no drift. A single source
 * of truth means a new check added to the collector must automatically
 * surface in the throwing variant's output.
 *
 * These tests exercise paths with no provider dependencies so no DB is
 * touched — collectDependencyErrors([]) short-circuits before any query.
 */

import { describe, it, expect } from "bun:test";
import { ApiError } from "../../src/lib/errors.ts";
import {
  collectAgentReadinessErrors,
  validateAgentReadiness,
} from "../../src/services/agent-readiness.ts";
import type { AgentManifest, LoadedPackage } from "../../src/types/index.ts";

function buildManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    name: "@test/readiness",
    displayName: "Readiness Test",
    version: "0.1.0",
    type: "agent",
    description: "Test",
    schemaVersion: "1.0",
    dependencies: { skills: {}, tools: {}, providers: {} },
    ...overrides,
  } as AgentManifest;
}

function buildAgent(overrides: Partial<LoadedPackage> = {}): LoadedPackage {
  return {
    id: "@test/readiness",
    manifest: buildManifest(),
    prompt: "do the thing",
    skills: [],
    tools: [],
    source: "local",
    ...overrides,
  };
}

describe("collectAgentReadinessErrors", () => {
  it("returns empty array for a ready agent", async () => {
    const errors = await collectAgentReadinessErrors({
      agent: buildAgent(),
      providerProfiles: {},
      orgId: "org-1",
      applicationId: "app-1",
    });
    expect(errors).toEqual([]);
  });

  it("flags empty prompt with code: empty_prompt", async () => {
    const errors = await collectAgentReadinessErrors({
      agent: buildAgent({ prompt: "" }),
      providerProfiles: {},
      orgId: "org-1",
      applicationId: "app-1",
    });
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toMatchObject({
      field: "prompt",
      code: "empty_prompt",
    });
  });

  it("flags missing skills + missing tools together", async () => {
    const manifest = buildManifest({
      dependencies: {
        skills: { "@test/skill-a": "1.0.0" },
        tools: { "@test/tool-a": "1.0.0" },
        providers: {},
      },
    });

    const errors = await collectAgentReadinessErrors({
      agent: buildAgent({ manifest, skills: [], tools: [] }),
      providerProfiles: {},
      orgId: "org-1",
      applicationId: "app-1",
    });

    const codes = errors.map((e) => e.code);
    expect(codes).toContain("missing_skill");
    expect(codes).toContain("missing_tool");
  });

  it("aggregates empty prompt + missing skill in stable order", async () => {
    const manifest = buildManifest({
      dependencies: {
        skills: { "@test/skill-a": "1.0.0" },
        tools: {},
        providers: {},
      },
    });

    const errors = await collectAgentReadinessErrors({
      agent: buildAgent({ prompt: "", manifest }),
      providerProfiles: {},
      orgId: "org-1",
      applicationId: "app-1",
    });

    // Prompt check runs before skills — order defines the first-thrown error.
    expect(errors[0]?.code).toBe("empty_prompt");
    expect(errors.some((e) => e.code === "missing_skill")).toBe(true);
  });
});

describe("validateAgentReadiness (throwing)", () => {
  it("succeeds silently when the collector returns no errors", async () => {
    await validateAgentReadiness({
      agent: buildAgent(),
      providerProfiles: {},
      orgId: "org-1",
      applicationId: "app-1",
    });
  });

  it("throws the first collected error with the matching ApiError code + title", async () => {
    // Empty prompt → collector's first entry is { code: "empty_prompt" }.
    // The throwing variant MUST preserve that code (backward compat) and
    // look up the human-readable title from the CODE_TITLES table.
    try {
      await validateAgentReadiness({
        agent: buildAgent({ prompt: "" }),
        providerProfiles: {},
        orgId: "org-1",
        applicationId: "app-1",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.code).toBe("empty_prompt");
      expect(apiErr.title).toBe("Empty Prompt");
    }
  });

  it("maps missing_skill code to Missing Skill title", async () => {
    const manifest = buildManifest({
      dependencies: {
        skills: { "@test/skill-a": "1.0.0" },
        tools: {},
        providers: {},
      },
    });

    try {
      await validateAgentReadiness({
        agent: buildAgent({ manifest, skills: [] }),
        providerProfiles: {},
        orgId: "org-1",
        applicationId: "app-1",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe("missing_skill");
      expect(apiErr.title).toBe("Missing Skill");
      expect(apiErr.message).toContain("@test/skill-a");
    }
  });
});
