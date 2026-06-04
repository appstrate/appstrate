// SPDX-License-Identifier: Apache-2.0

/**
 * `deriveProviderFromApi` is the single source of truth mapping a Pi
 * `MODEL_API` shape to the Pi SDK `AuthStorage` provider key. The entrypoint
 * uses it to populate `model.provider`, which the runner then reads verbatim
 * to register + resolve the API key — so this table is the only place the
 * api→provider translation lives.
 */

import { describe, it, expect } from "bun:test";
import { deriveProviderFromApi } from "../src/index.ts";

describe("deriveProviderFromApi", () => {
  it("maps each known api shape to its SDK provider key (n→1)", () => {
    expect(deriveProviderFromApi("anthropic-messages")).toBe("anthropic");
    // The three OpenAI-family shapes all collapse to one provider key.
    expect(deriveProviderFromApi("openai-completions")).toBe("openai");
    expect(deriveProviderFromApi("openai-responses")).toBe("openai");
    expect(deriveProviderFromApi("openai-codex-responses")).toBe("openai");
    expect(deriveProviderFromApi("mistral-conversations")).toBe("mistral");
    expect(deriveProviderFromApi("google-generative-ai")).toBe("google");
    expect(deriveProviderFromApi("google-vertex")).toBe("google-vertex");
    expect(deriveProviderFromApi("azure-openai-responses")).toBe("azure-openai-responses");
    expect(deriveProviderFromApi("bedrock-converse-stream")).toBe("amazon-bedrock");
  });

  it("throws on an unknown api shape rather than guessing", () => {
    expect(() => deriveProviderFromApi("totally-made-up")).toThrow(/unknown model api/i);
    expect(() => deriveProviderFromApi("")).toThrow(/unknown model api/i);
  });
});
