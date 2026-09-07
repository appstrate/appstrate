// SPDX-License-Identifier: Apache-2.0

/**
 * What the provider picker offers.
 *
 * The rows are asserted here rather than in the rendered markup: a Radix
 * `SelectContent` is a portal and renders nothing without a DOM, so the picker
 * shows up in a static render as its trigger alone.
 *
 * The property that matters is the collapse — however many registry entries let
 * the operator point at their own endpoint (`openai-compatible`, and any
 * sibling a module adds later), the picker offers ONE row for all of them, and
 * offers it last. Which of them is used is then the endpoint arrangement's
 * "API type" question.
 */

import { describe, it, expect } from "bun:test";
import {
  buildProviderPickerRows,
  CUSTOM_ENDPOINT_ID,
  pickedProviderId,
} from "../provider-registry-helpers.ts";

const entry = (id: string, overridable: boolean, featured = false) => ({
  providerId: id,
  featured,
  baseUrlOverridable: overridable,
});

describe("buildProviderPickerRows", () => {
  it("collapses every overridable entry into a single row, whatever their number", () => {
    const rows = buildProviderPickerRows([
      entry("anthropic", false, true),
      entry("openai-compatible", true),
      entry("anthropic-compatible", true),
    ]);
    expect(rows.filter((r) => r.kind === "customEndpoint")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "provider").map((r) => r.entry.providerId)).toEqual([
      "anthropic",
    ]);
  });

  it("puts that row last, and in the unfeatured group", () => {
    const rows = buildProviderPickerRows([
      entry("openai-compatible", true),
      entry("openai", false),
    ]);
    expect(rows[rows.length - 1]).toEqual({ kind: "customEndpoint", featured: false });
  });

  it("offers no such row when no entry can be pointed elsewhere", () => {
    const rows = buildProviderPickerRows([entry("anthropic", false), entry("openai", false)]);
    expect(rows.every((r) => r.kind === "provider")).toBe(true);
  });
});

describe("pickedProviderId", () => {
  const registry = [
    entry("anthropic", false),
    entry("openai-compatible", true),
    entry("anthropic-compatible", true),
  ];

  it("opens the custom-endpoint row on the first overridable entry", () => {
    expect(pickedProviderId(CUSTOM_ENDPOINT_ID, registry)).toBe("openai-compatible");
  });

  it("passes a real provider id through untouched", () => {
    expect(pickedProviderId("anthropic", registry)).toBe("anthropic");
  });

  it("resolves to nothing when no entry is overridable", () => {
    expect(pickedProviderId(CUSTOM_ENDPOINT_ID, [entry("anthropic", false)])).toBe("");
  });
});
