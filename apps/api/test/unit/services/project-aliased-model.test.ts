// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 2 (model alias) — `projectAliasedModel` is the user-facing read
 * boundary that strips a model alias's real binding. A non-aliased model must
 * pass through byte-for-byte; an aliased one must keep only the public surface
 * (id/label/flags/timestamps) and null EVERYTHING that could identify the
 * backing — ids, endpoint, AND catalog-derived capability/cost (a distinctive
 * window or price would itself fingerprint the real model).
 */

import { describe, it, expect } from "bun:test";
import { projectAliasedModel } from "../../../src/services/org-models.ts";
import type { OrgModelInfo } from "@appstrate/shared-types";

const base: OrgModelInfo = {
  id: "appstrate-medium",
  label: "Appstrate Medium",
  apiShape: "openai-completions",
  providerId: "openai-compatible",
  baseUrl: "https://api.deepseek.com/v1",
  modelId: "deepseek-chat",
  input: ["text"],
  contextWindow: 64000,
  maxTokens: 8192,
  reasoning: false,
  cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
  enabled: true,
  is_default: false,
  aliased: false,
  source: "built-in",
  credentialId: "deepseek-prod",
  created_by: null,
  createdAt: "2026-01-10T08:00:00Z",
  updatedAt: "2026-01-10T08:00:00Z",
};

describe("projectAliasedModel", () => {
  it("passes a non-aliased model through unchanged", () => {
    expect(projectAliasedModel(base)).toEqual(base);
  });

  it("strips the entire backing for an aliased model", () => {
    const out = projectAliasedModel({ ...base, aliased: true });

    // Public surface survives.
    expect(out.id).toBe("appstrate-medium");
    expect(out.label).toBe("Appstrate Medium");
    expect(out.aliased).toBe(true);
    expect(out.enabled).toBe(true);
    expect(out.source).toBe("built-in");

    // Binding + catalog-derived metadata are all nulled.
    expect(out.apiShape).toBeNull();
    expect(out.baseUrl).toBeNull();
    expect(out.modelId).toBeNull();
    expect(out.credentialId).toBeNull();
    expect(out.input).toBeNull();
    expect(out.contextWindow).toBeNull();
    expect(out.maxTokens).toBeNull();
    expect(out.reasoning).toBeNull();
    expect(out.cost).toBeNull();

    // Hard guarantee: nothing identifying the backing survives serialization.
    const json = JSON.stringify(out);
    expect(json).not.toContain("deepseek");
    expect(json).not.toContain("deepseek-chat");
    expect(json).not.toContain("api.deepseek.com");
  });
});
