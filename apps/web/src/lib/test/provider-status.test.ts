// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { hasDisconnectedProviders, isProviderStatusConnected } from "../provider-status";

describe("isProviderStatusConnected", () => {
  it("returns true for connected", () => {
    expect(isProviderStatusConnected("connected")).toBe(true);
  });

  it("returns true for needs_reconnection", () => {
    expect(isProviderStatusConnected("needs_reconnection")).toBe(true);
  });

  it("returns false for not_connected", () => {
    expect(isProviderStatusConnected("not_connected")).toBe(false);
  });
});

describe("hasDisconnectedProviders", () => {
  it("returns false when all providers are connected with sufficient scopes", () => {
    const providers = [
      { status: "connected", scopesSufficient: true },
      { status: "connected", scopesSufficient: true },
    ];
    expect(hasDisconnectedProviders(providers)).toBe(false);
  });

  it("returns true when a provider is not connected", () => {
    const providers = [
      { status: "connected", scopesSufficient: true },
      { status: "not_connected" },
    ];
    expect(hasDisconnectedProviders(providers)).toBe(true);
  });

  it("returns true when a provider has insufficient scopes", () => {
    const providers = [
      { status: "connected", scopesSufficient: true },
      { status: "connected", scopesSufficient: false },
    ];
    expect(hasDisconnectedProviders(providers)).toBe(true);
  });

  it("returns false when scopesSufficient is undefined (no scope requirements)", () => {
    const providers = [{ status: "connected" }, { status: "connected" }];
    expect(hasDisconnectedProviders(providers)).toBe(false);
  });

  it("returns false when scopesSufficient is null", () => {
    const providers = [{ status: "connected", scopesSufficient: null }];
    expect(hasDisconnectedProviders(providers)).toBe(false);
  });
});
