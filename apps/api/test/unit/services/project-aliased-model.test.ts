// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 2 (model alias) — `projectAliasedModel` is the user-facing read
 * boundary that strips a model alias's real binding. A non-aliased model must
 * pass through byte-for-byte; an aliased one must keep only the public surface
 * (id/label/flags/timestamps) and the portable generation contract required by
 * the client. Provider-native mappings and every other catalog-derived field
 * stay private.
 */

import { describe, it, expect } from "bun:test";
import { projectAliasedModel } from "../../../src/services/org-models.ts";
import type { OrgModelInfo } from "@appstrate/shared-types";

const base: OrgModelInfo = {
  id: "appstrate-medium",
  label: "Appstrate Medium",
  apiShape: "openai-completions",
  providerId: "openai-compatible",
  providerName: "OpenAI-compatible (custom)",
  baseUrl: "https://api.deepseek.com/v1",
  modelId: "deepseek-chat",
  generation: {
    temperature: "unsupported",
    reasoning: {
      supported: "supported",
      adaptive: true,
      levels: {
        off: "supported",
        minimal: "unsupported",
        low: "supported",
        medium: "supported",
        high: "supported",
        xhigh: "supported",
        max: "supported",
      },
      nativeLevels: { off: "none", max: "max" },
    },
  },
  input: ["text"],
  contextWindow: 64000,
  maxTokens: 8192,
  reasoning: false,
  cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
  enabled: true,
  is_default: false,
  needs_reconnection: false,
  aliased: false,
  iconUrl: null,
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

  it("strips the backing but keeps portable generation capabilities for an alias", () => {
    const out = projectAliasedModel({ ...base, aliased: true });

    // Public surface survives.
    expect(out.id).toBe("appstrate-medium");
    expect(out.label).toBe("Appstrate Medium");
    expect(out.aliased).toBe(true);
    expect(out.enabled).toBe(true);
    expect(out.source).toBe("built-in");

    // Binding + identifying catalog metadata are all nulled.
    // (iconUrl is a deliberate public choice, decoupled from the backing — see
    // the dedicated case below; it must survive the projection.)
    expect(out.apiShape).toBeNull();
    expect(out.providerId).toBeNull();
    expect(out.providerName).toBeNull();
    expect(out.baseUrl).toBeNull();
    expect(out.modelId).toBeNull();
    expect(out.credentialId).toBeNull();
    expect(out.input).toBeNull();
    expect(out.contextWindow).toBeNull();
    expect(out.maxTokens).toBeNull();
    expect(out.reasoning).toBeNull();
    expect(out.cost).toBeNull();
    expect(out.generation).toEqual({
      temperature: "unsupported",
      reasoning: {
        supported: "supported",
        adaptive: null,
        levels: {
          off: "supported",
          minimal: "unsupported",
          low: "supported",
          medium: "supported",
          high: "supported",
          xhigh: "supported",
          max: "supported",
        },
      },
    });

    // Hard guarantee: nothing identifying the backing survives serialization.
    const json = JSON.stringify(out);
    expect(json).not.toContain("deepseek");
    expect(json).not.toContain("deepseek-chat");
    expect(json).not.toContain("api.deepseek.com");
    expect(json).not.toContain("nativeLevels");
  });

  it("keeps alias controls fail-closed without catalog-confirmed support", () => {
    const out = projectAliasedModel({
      ...base,
      aliased: true,
      generation: {
        temperature: "unknown",
        reasoning: { supported: "unknown", adaptive: null, levels: {} },
      },
    });

    expect(out.generation).toEqual({
      temperature: "unsupported",
      reasoning: { supported: "unsupported", adaptive: null, levels: {} },
    });
  });

  it("fails closed when an alias pair is not explicitly compatible", () => {
    const out = projectAliasedModel({
      ...base,
      aliased: true,
      generation: {
        temperature: "supported",
        reasoning: {
          supported: "supported",
          adaptive: null,
          levels: { low: "supported" },
        },
      },
    });

    expect(out.generation?.reasoning.temperatureCompatible).toBe("unsupported");
  });

  it("preserves explicitly compatible alias pairs", () => {
    const out = projectAliasedModel({
      ...base,
      aliased: true,
      generation: {
        temperature: "supported",
        reasoning: {
          supported: "supported",
          temperatureCompatible: "supported",
          adaptive: null,
          levels: { low: "supported" },
        },
      },
    });

    expect(out.generation?.reasoning.temperatureCompatible).toBe("supported");
  });

  it("preserves needs_reconnection on an aliased model", () => {
    // An availability bit, not part of the backing: it names no provider,
    // endpoint or upstream id. An aliased DB row can sit on a dead OAuth
    // credential, and the operator surface needs to know why it is unusable.
    const out = projectAliasedModel({ ...base, aliased: true, needs_reconnection: true });
    expect(out.needs_reconnection).toBe(true);
    expect(out.providerId).toBeNull(); // backing still hidden
    expect(out.baseUrl).toBeNull();
  });

  it("preserves a declared iconUrl on an aliased model", () => {
    // iconUrl is chosen on the alias, not derived from the backing — it carries
    // no fingerprint, so the projection keeps it for the UI to render an icon.
    const out = projectAliasedModel({ ...base, aliased: true, iconUrl: "anthropic" });
    expect(out.iconUrl).toBe("anthropic");
    expect(out.apiShape).toBeNull(); // backing still hidden
  });
});
