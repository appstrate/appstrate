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
  resolveProviderEntry,
} from "../provider-registry-helpers.ts";
import type { ProviderRegistryEntry } from "../../hooks/use-model-provider-credentials.ts";

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

describe("resolveProviderEntry", () => {
  const registryEntry = (
    providerId: string,
    apiShape: ProviderRegistryEntry["apiShape"],
    defaultBaseUrl: string,
    iconUrl: string,
  ): ProviderRegistryEntry => ({
    providerId,
    displayName: providerId,
    iconUrl,
    description: null,
    docsUrl: null,
    apiShape,
    defaultBaseUrl,
    baseUrlOverridable: providerId.endsWith("-compatible"),
    authMode: "api_key",
    featured: false,
    models: [],
  });
  const registry = [
    registryEntry("anthropic", "anthropic-messages", "https://api.anthropic.com", "anthropic"),
    registryEntry("openai-compatible", "openai-completions", "http://localhost:11434", "openai"),
  ];

  it("reads a custom endpoint's entry off its providerId, whatever URL it runs on", () => {
    // The whole reason the id comes first: no registry `defaultBaseUrl` is a
    // prefix of an operator's own host, so the URL match answers nothing.
    const row = {
      providerId: "openai-compatible",
      apiShape: "openai-completions",
      baseUrl: "https://vllm.internal/v1",
    };
    expect(resolveProviderEntry(row, registry)?.iconUrl).toBe("openai");
  });

  it("falls back to the endpoint match where the binding is hidden", () => {
    // Built-in credentials and aliased models carry no providerId but do pin a
    // registry endpoint.
    const row = {
      providerId: null,
      apiShape: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/",
    };
    expect(resolveProviderEntry(row, registry)?.providerId).toBe("anthropic");
  });

  it("answers nothing for a row no entry claims", () => {
    const row = {
      providerId: "gone",
      apiShape: "openai-completions",
      baseUrl: "https://x.test/v1",
    };
    expect(resolveProviderEntry(row, registry)).toBeUndefined();
  });
});
