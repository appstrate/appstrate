// SPDX-License-Identifier: Apache-2.0

/**
 * Whether an edited row answers for its own capabilities, or still follows the
 * catalog.
 *
 * `GET /api/models` returns RESOLVED values, so "the row carries a number" is
 * not the question — a catalogued row always carries the catalog's. Reading it
 * that way would open the capabilities toggle on every catalogued row, and
 * saving would freeze those numbers as overrides: renaming a model would
 * silently cut it off from the weekly catalog refresh.
 */

import { describe, it, expect } from "bun:test";
import { rowOverridesCatalog } from "../row-overrides-catalog.ts";

/** What the registry publishes for `claude-sonnet-4-5-20250929`. */
const ENTRY = {
  contextWindow: 200000,
  maxTokens: 64000,
  capabilities: ["text", "image", "reasoning"],
};

/** What `GET /api/models` returns for a row bound to it and overriding nothing. */
const RESOLVED = {
  input: ["text", "image"],
  contextWindow: 200000,
  maxTokens: 64000,
  reasoning: true,
};

describe("rowOverridesCatalog — the row has a registry entry", () => {
  it("reads resolved-equals-catalog as no override at all", () => {
    expect(rowOverridesCatalog(RESOLVED, ENTRY)).toBe(false);
  });

  it("reads a different context window as the operator's own answer", () => {
    expect(rowOverridesCatalog({ ...RESOLVED, contextWindow: 32768 }, ENTRY)).toBe(true);
  });

  it("reads a different max-output the same way", () => {
    expect(rowOverridesCatalog({ ...RESOLVED, maxTokens: 4096 }, ENTRY)).toBe(true);
  });

  it("compares the modalities as a set, not as a sequence", () => {
    expect(rowOverridesCatalog({ ...RESOLVED, input: ["image", "text"] }, ENTRY)).toBe(false);
    expect(rowOverridesCatalog({ ...RESOLVED, input: ["text"] }, ENTRY)).toBe(true);
  });

  it("reads a flipped reasoning flag as an override", () => {
    expect(rowOverridesCatalog({ ...RESOLVED, reasoning: false }, ENTRY)).toBe(true);
  });

  it("ignores the name, which the operator owns and the catalog does not", () => {
    // The whole point: renaming a catalogued row must not turn its catalog
    // numbers into frozen overrides on the next save.
    expect(rowOverridesCatalog(RESOLVED, ENTRY)).toBe(false);
  });

  it("treats a value the row does not carry as nothing to compare", () => {
    expect(rowOverridesCatalog({}, ENTRY)).toBe(false);
  });

  it("reads any max-output as an override where the catalog declares none", () => {
    expect(rowOverridesCatalog({ maxTokens: 8192 }, { ...ENTRY, maxTokens: null })).toBe(true);
  });
});

describe("rowOverridesCatalog — nothing in the catalog claims the row", () => {
  it("reads every carried value as the operator's, since nothing else answers", () => {
    expect(rowOverridesCatalog({ contextWindow: 32768 }, undefined)).toBe(true);
    expect(rowOverridesCatalog({ input: ["text"] }, undefined)).toBe(true);
    expect(rowOverridesCatalog({ reasoning: false }, undefined)).toBe(true);
  });

  it("reads a row that carries nothing as still on auto", () => {
    expect(
      rowOverridesCatalog(
        { input: null, contextWindow: null, maxTokens: null, reasoning: null },
        undefined,
      ),
    ).toBe(false);
  });

  it("reads an empty modality list as nothing described", () => {
    expect(rowOverridesCatalog({ input: [] }, undefined)).toBe(false);
  });
});
