// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, afterEach } from "bun:test";
import type { UIMessage } from "ai";
import { buildPromptFromMessages, buildSdkEnv } from "../src/claude-agent/engine.ts";

const userMsg = (text: string): UIMessage => ({
  id: crypto.randomUUID(),
  role: "user",
  parts: [{ type: "text", text }],
});
const assistantMsg = (text: string): UIMessage => ({
  id: crypto.randomUUID(),
  role: "assistant",
  parts: [{ type: "text", text }],
});

describe("buildPromptFromMessages", () => {
  test("a single user turn is sent verbatim (no transcript labels)", () => {
    expect(buildPromptFromMessages([userMsg("salut")])).toBe("salut");
  });

  test("multi-turn threads become a labelled transcript", () => {
    const prompt = buildPromptFromMessages([
      userMsg("bonjour"),
      assistantMsg("salut, comment puis-je aider ?"),
      userMsg("liste mes agents"),
    ]);
    expect(prompt).toBe(
      "User: bonjour\n\nAssistant: salut, comment puis-je aider ?\n\nUser: liste mes agents",
    );
  });

  test("skips messages with no text content and ignores non-text parts", () => {
    const withTool: UIMessage = {
      id: "x",
      role: "assistant",
      parts: [{ type: "step-start" } as never, { type: "text", text: "ok" }],
    };
    expect(buildPromptFromMessages([userMsg("hi"), withTool])).toBe("User: hi\n\nAssistant: ok");
  });

  test("returns an empty string when there is no usable content", () => {
    expect(buildPromptFromMessages([])).toBe("");
    expect(buildPromptFromMessages([userMsg("   ")])).toBe("");
  });
});

describe("buildSdkEnv — credential isolation", () => {
  afterEach(() => {
    delete process.env.APPSTRATE_FAKE_SECRET;
  });

  test("injects the gateway pointers and a placeholder bearer", () => {
    const env = buildSdkEnv("http://127.0.0.1:3000/api/llm-proxy/claude-code-sdk/p1", "chatloop_x");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3000/api/llm-proxy/claude-code-sdk/p1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("chatloop_x");
    // Empty API key so an ambient key can never flip the binary off the OAuth path.
    expect(env.ANTHROPIC_API_KEY).toBe("");
  });

  test("does NOT forward arbitrary platform secrets to the spawned binary", () => {
    process.env.APPSTRATE_FAKE_SECRET = "super-secret-value";
    const env = buildSdkEnv("http://gw", "tok");
    expect(env.APPSTRATE_FAKE_SECRET).toBeUndefined();
    // No value anywhere in the env should carry the secret.
    expect(JSON.stringify(env)).not.toContain("super-secret-value");
    delete process.env.APPSTRATE_FAKE_SECRET;
  });

  test("passes through only the runtime essentials the binary needs", () => {
    const env = buildSdkEnv("http://gw", "tok");
    // PATH is required to spawn; it is forwarded when present.
    if (process.env.PATH) expect(env.PATH).toBe(process.env.PATH);
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.DISABLE_TELEMETRY).toBe("1");
  });
});
