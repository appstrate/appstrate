// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { selectRunEngine } from "../../../src/services/run-launcher/engine-select.ts";

describe("selectRunEngine", () => {
  it("routes claude-code to the Claude engine when enabled", () => {
    expect(selectRunEngine({ providerId: "claude-code" }, true)).toBe("claude");
  });

  it("keeps claude-code on Pi while the flag is off (kill-switch)", () => {
    expect(selectRunEngine({ providerId: "claude-code" }, false)).toBe("pi");
  });

  it("never routes a non-claude-code provider to the Claude engine", () => {
    // anthropic (api-key) shares the apiShape but must stay on Pi.
    expect(selectRunEngine({ providerId: "anthropic" }, true)).toBe("pi");
    expect(selectRunEngine({ providerId: "openai" }, true)).toBe("pi");
    // codex migration is deferred — it stays on Pi even when the flag is on.
    expect(selectRunEngine({ providerId: "codex" }, true)).toBe("pi");
  });

  it("defaults everything to Pi when the flag is off", () => {
    for (const providerId of ["claude-code", "anthropic", "codex", "openai-compatible"]) {
      expect(selectRunEngine({ providerId }, false)).toBe("pi");
    }
  });
});
