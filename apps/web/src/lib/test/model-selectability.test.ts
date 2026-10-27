// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { isMemberPaid, isModelPinUnavailable } from "../model-selectability";
import type { OrgModelInfo } from "../../hooks/use-models";

function model(over: Partial<OrgModelInfo>): OrgModelInfo {
  return {
    id: "m1",
    label: "Claude",
    apiShape: "anthropic-messages",
    providerId: "anthropic",
    provider_name: "Anthropic",
    pi_provider: "anthropic",
    pi_dialect: null,
    base_url: "https://api.anthropic.com",
    modelId: "claude-sonnet-4",
    enabled: true,
    is_default: false,
    needs_reconnection: false,
    aliased: false,
    iconUrl: null,
    source: "custom",
    binding: "org",
    credentialId: "c1",
    billed_to: "org",
    created_by: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
    generation: over.generation ?? null,
  };
}

describe("isModelPinUnavailable", () => {
  it("no pin → available", () => {
    expect(isModelPinUnavailable([model({})], null)).toBe(false);
  });

  it("a pin on an enabled, connected model → available", () => {
    expect(isModelPinUnavailable([model({})], "m1")).toBe(false);
  });

  it("a pin on a model that is gone, disabled or needs reconnection → unavailable", () => {
    expect(isModelPinUnavailable([model({})], "other")).toBe(true);
    expect(isModelPinUnavailable([model({ enabled: false })], "m1")).toBe(true);
    expect(isModelPinUnavailable([model({ needs_reconnection: true })], "m1")).toBe(true);
  });
});

describe("isMemberPaid", () => {
  it("is true for a model each member serves with their own credential", () => {
    expect(isMemberPaid(model({ binding: "user", credentialId: null, billed_to: null }))).toBe(
      true,
    );
  });

  it("is false for a model bound to one credential, a built-in model or a managed alias", () => {
    expect(isMemberPaid(model({ binding: "org" }))).toBe(false);
    expect(isMemberPaid(model({ binding: "system", billed_to: "system" }))).toBe(false);
    expect(isMemberPaid(model({ binding: "managed" }))).toBe(false);
  });
});
