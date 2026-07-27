// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { isModelSelectable } from "../model-selectability";
import type { OrgModelInfo } from "../../hooks/use-models";

function model(over: Partial<OrgModelInfo>): OrgModelInfo {
  return {
    id: "m1",
    label: "Claude",
    apiShape: "anthropic-messages",
    providerId: "anthropic",
    providerName: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    modelId: "claude-sonnet-4",
    enabled: true,
    is_default: false,
    needs_reconnection: false,
    aliased: false,
    iconUrl: null,
    source: "custom",
    credentialId: "c1",
    created_by: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
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

  it("disabled AND dead → not selectable", () => {
    expect(isModelSelectable(model({ enabled: false, needs_reconnection: true }))).toBe(false);
  });

  it("built-in models read their key from the env, so they stay selectable", () => {
    expect(isModelSelectable(model({ source: "built-in", credentialId: null }))).toBe(true);
  });

  it("an alias (binding projected away) is judged on the same two fields", () => {
    const alias = model({ aliased: true, apiShape: null, modelId: null, credentialId: null });
    expect(isModelSelectable(alias)).toBe(true);
    expect(isModelSelectable({ ...alias, needs_reconnection: true })).toBe(false);
  });
});
