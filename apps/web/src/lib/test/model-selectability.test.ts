// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { isMemberPaid, isModelSelectable } from "../model-selectability";
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

describe("isModelSelectable", () => {
  it("enabled + live credential → selectable", () => {
    expect(isModelSelectable(model({}))).toBe(true);
  });

  it("disabled → not selectable", () => {
    expect(isModelSelectable(model({ enabled: false }))).toBe(false);
  });

  it("dead credential → not selectable even though the row is listed", () => {
    expect(isModelSelectable(model({ needs_reconnection: true }))).toBe(false);
  });
});

describe("isMemberPaid", () => {
  it("is true for a model each member serves with their own credential", () => {
    expect(isMemberPaid(model({ binding: "member", credentialId: null, billed_to: null }))).toBe(
      true,
    );
  });

  it("is false for a model bound to one credential or a managed alias", () => {
    expect(isMemberPaid(model({ binding: "org" }))).toBe(false);
    expect(isMemberPaid(model({ binding: "managed" }))).toBe(false);
  });
});
