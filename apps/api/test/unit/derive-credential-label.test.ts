// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `deriveCredentialLabel` — the default name a credential gets
 * when the caller supplies none. A custom endpoint is named after its host,
 * because otherwise every endpoint behind one provider entry shares the
 * provider's display name.
 */

import { describe, it, expect } from "bun:test";
import { deriveCredentialLabel } from "../../src/services/model-providers/credentials.ts";

const CUSTOM = { displayName: "OpenAI-compatible (custom)", baseUrlOverridable: true };
const PINNED = { displayName: "OpenAI", baseUrlOverridable: false };

describe("deriveCredentialLabel", () => {
  it("names a custom endpoint after its host, port included", () => {
    expect(deriveCredentialLabel(CUSTOM, "http://localhost:11434/v1")).toBe(
      "localhost:11434 · OpenAI-compatible (custom)",
    );
    expect(deriveCredentialLabel(CUSTOM, "https://llm.example.test/v1")).toBe(
      "llm.example.test · OpenAI-compatible (custom)",
    );
  });

  it("falls back to the display name when no override is given", () => {
    for (const override of [null, undefined, ""]) {
      expect(deriveCredentialLabel(CUSTOM, override)).toBe("OpenAI-compatible (custom)");
    }
  });

  it("ignores an override the provider does not accept", () => {
    expect(deriveCredentialLabel(PINNED, "http://localhost:11434/v1")).toBe("OpenAI");
  });

  it("falls back to the display name when the override does not parse", () => {
    expect(deriveCredentialLabel(CUSTOM, "not a url")).toBe("OpenAI-compatible (custom)");
  });
});
