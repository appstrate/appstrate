// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import claudeCodeModule from "../../src/index.ts";
import { isCatalogModelSelector } from "@appstrate/core/module";
import type { CatalogModelSelector, CredentialValidationResult } from "@appstrate/core/module";

const def = (claudeCodeModule.modelProviders?.() ?? [])[0]!;

function validate(args: {
  apiKey: string;
  accountId?: string;
  expiresAt?: number | null;
}): CredentialValidationResult | undefined {
  return def.hooks?.validateCredential?.(args);
}

describe("claude-code discovery candidates", () => {
  it("declares static modelDiscovery with catalog-derived selectors", () => {
    // Both lists are `CatalogModelSelector`s resolved platform-side against
    // the vendored anthropic catalog (this package has no catalog, so the
    // resolved ids are asserted in the API suite). What is checkable here is
    // the declaration: same families in both, more generations for the
    // candidate list so a plan lagging the current release keeps its model.
    expect(def.modelDiscovery?.mode).toBe("static");
    expect(isCatalogModelSelector(def.featuredModels)).toBe(true);
    expect(def.modelDiscoveryCandidates).toBeDefined();
    expect(isCatalogModelSelector(def.modelDiscoveryCandidates!)).toBe(true);

    const featured = def.featuredModels as CatalogModelSelector;
    const candidates = def.modelDiscoveryCandidates as CatalogModelSelector;
    expect(candidates.catalogFamilies).toEqual(featured.catalogFamilies);
    expect(candidates.generations).toBeGreaterThan(featured.generations);
    // No cap on candidates: the featured `limit` exists to keep the picker's
    // Featured row short, and must not leak into discovery.
    expect(candidates.limit).toBeUndefined();
  });
});

describe("claude-code offline credential validation", () => {
  it("validates offline via validateCredential and declares NO buildInferenceProbe (forging removed)", () => {
    // Real inference runs on the Pi engine (pi-ai emits the provider's
    // subscription request shape); the platform issues ZERO Anthropic API calls
    // to test a credential. Offline validation is inferred from the presence of the
    // validateCredential hook; static discovery comes from modelDiscovery.mode.
    expect(def.modelDiscovery?.mode).toBe("static");
    expect(def.hooks?.validateCredential).toBeFunction();
    expect((def.hooks as Record<string, unknown>).buildInferenceProbe).toBeUndefined();
    expect((def as Record<string, unknown>).oauthWireFormat).toBeUndefined();
  });

  it("rejects a well-formed bearer with NO expiry metadata (expiry unverifiable offline)", () => {
    // Anthropic OAuth tokens are not JWTs, so the row's `expiresAt` is the only
    // expiry source. Absent it, a dead token would otherwise pass — reject.
    const out = validate({ apiKey: "sk-ant-oat-test" });
    expect(out?.ok).toBe(false);
    if (out?.ok === false) {
      expect(out.error).toBe("AUTH_FAILED");
      expect(out.message).toMatch(/expiry could not be verified/i);
    }
  });

  it("accepts a well-formed bearer with a future expiresAt", () => {
    expect(validate({ apiKey: "sk-ant-oat-test", expiresAt: Date.now() + 60_000 })).toEqual({
      ok: true,
    });
  });

  it("rejects an empty / whitespace bearer (AUTH_FAILED)", () => {
    for (const bad of ["", "   "]) {
      const out = validate({ apiKey: bad });
      expect(out?.ok).toBe(false);
      if (out?.ok === false) expect(out.error).toBe("AUTH_FAILED");
    }
  });

  it("rejects a bearer whose credential row carries a past expiresAt", () => {
    const out = validate({ apiKey: "sk-ant-oat-test", expiresAt: Date.now() - 1 });
    expect(out?.ok).toBe(false);
    if (out?.ok === false) {
      expect(out.error).toBe("AUTH_FAILED");
      expect(out.message).toContain("expired");
    }
  });
});
