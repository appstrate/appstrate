// SPDX-License-Identifier: Apache-2.0

/**
 * The model half of the run-button gate. `resolvesToUsableModel` has to mirror
 * the server cascade in `resolveModel` (agent pin → org default): a green Run
 * button that ends in an inference error, or a greyed one for a run the server
 * would have happily resolved, are both wrong.
 */

import { describe, it, expect } from "bun:test";
import { resolvesToUsableModel } from "../use-agent-readiness";
import type { OrgModelInfo } from "../use-models";

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

const DEFAULT_OK = model({ id: "m_default", is_default: true });

describe("resolvesToUsableModel", () => {
  it("accepts a usable pin", () => {
    expect(resolvesToUsableModel([model({ id: "m_pin" })], "m_pin")).toBe(true);
  });

  it("accepts a usable org default with no pin", () => {
    expect(resolvesToUsableModel([DEFAULT_OK], null)).toBe(true);
  });

  it("falls back to the org default when the pin is dead", () => {
    // `resolveModel` step 1 returns null for a dead pin and drops to step 2.
    const pin = model({ id: "m_pin", needs_reconnection: true });
    expect(resolvesToUsableModel([pin, DEFAULT_OK], "m_pin")).toBe(true);
  });

  it("falls back to the org default when the pin is not listed at all", () => {
    expect(resolvesToUsableModel([DEFAULT_OK], "m_deleted")).toBe(true);
  });

  it("rejects a dead pin with a dead default — nothing left to resolve", () => {
    const pin = model({ id: "m_pin", needs_reconnection: true });
    const dead = model({ id: "m_default", is_default: true, needs_reconnection: true });
    expect(resolvesToUsableModel([pin, dead], "m_pin")).toBe(false);
  });

  it("rejects a disabled org default", () => {
    expect(resolvesToUsableModel([model({ is_default: true, enabled: false })], null)).toBe(false);
  });

  it("rejects a catalog with no default at all", () => {
    expect(resolvesToUsableModel([model({ id: "m_other" })], null)).toBe(false);
  });

  it("rejects an empty catalog", () => {
    expect(resolvesToUsableModel([], "m_pin")).toBe(false);
  });
});
