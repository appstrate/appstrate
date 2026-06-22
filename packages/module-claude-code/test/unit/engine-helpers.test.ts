// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, afterEach } from "bun:test";
import { buildSdkEnv } from "../../src/claude-agent/engine.ts";

describe("buildSdkEnv — credential isolation", () => {
  afterEach(() => {
    delete process.env.APPSTRATE_FAKE_SECRET;
  });

  it("injects the gateway pointers and a placeholder bearer", () => {
    const env = buildSdkEnv("http://127.0.0.1:3000/api/llm-proxy/claude-code-sdk/p1", "chatloop_x");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3000/api/llm-proxy/claude-code-sdk/p1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("chatloop_x");
    // Empty API key so an ambient key can never flip the binary off the OAuth path.
    expect(env.ANTHROPIC_API_KEY).toBe("");
  });

  it("does NOT forward arbitrary platform secrets to the spawned binary", () => {
    process.env.APPSTRATE_FAKE_SECRET = "super-secret-value";
    const env = buildSdkEnv("http://gw", "tok");
    expect(env.APPSTRATE_FAKE_SECRET).toBeUndefined();
    // No value anywhere in the env should carry the secret.
    expect(JSON.stringify(env)).not.toContain("super-secret-value");
    delete process.env.APPSTRATE_FAKE_SECRET;
  });

  it("passes through only the runtime essentials the binary needs", () => {
    const env = buildSdkEnv("http://gw", "tok");
    // PATH is required to spawn; it is forwarded when present.
    if (process.env.PATH) expect(env.PATH).toBe(process.env.PATH);
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.DISABLE_TELEMETRY).toBe("1");
  });
});
