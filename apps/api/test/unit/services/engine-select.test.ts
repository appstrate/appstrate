// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  selectRunEngine,
  buildOauthSidecarLlm,
} from "../../../src/services/run-launcher/engine-select.ts";

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

describe("buildOauthSidecarLlm", () => {
  const wireFormat = {
    identityHeaders: { "x-app": "cli" },
    systemPrepend: { type: "text" as const, text: "You are Claude Code." },
  };

  it("uses oauth-passthrough on the claude engine and drops the forging wireFormat", () => {
    const cfg = buildOauthSidecarLlm({
      engine: "claude",
      baseUrl: "https://api.anthropic.com",
      credentialId: "cred_1",
      wireFormat,
    });
    expect(cfg).toEqual({
      authMode: "oauth-passthrough",
      baseUrl: "https://api.anthropic.com",
      credentialId: "cred_1",
    });
    // No identity-header / system-prepend forging leaks onto the passthrough path.
    expect("wireFormat" in cfg).toBe(false);
  });

  it("uses forging oauth on the pi engine and keeps the wireFormat", () => {
    const cfg = buildOauthSidecarLlm({
      engine: "pi",
      baseUrl: "https://api.anthropic.com",
      credentialId: "cred_1",
      wireFormat,
    });
    expect(cfg.authMode).toBe("oauth");
    expect((cfg as { wireFormat?: unknown }).wireFormat).toEqual(wireFormat);
  });

  it("carries modelSwap through on both engines", () => {
    const modelSwap = { alias: "appstrate-small", real: "claude-haiku-4-5" };
    expect(
      buildOauthSidecarLlm({ engine: "claude", baseUrl: "u", credentialId: "c", modelSwap }),
    ).toMatchObject({ authMode: "oauth-passthrough", modelSwap });
    expect(
      buildOauthSidecarLlm({ engine: "pi", baseUrl: "u", credentialId: "c", modelSwap }),
    ).toMatchObject({ authMode: "oauth", modelSwap });
  });
});
