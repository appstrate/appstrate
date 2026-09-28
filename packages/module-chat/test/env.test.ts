// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { chatEnvSchema, getChatEnv, _resetChatEnvForTests } from "../src/env.ts";

const saved = { CHAT_SELF_ORIGIN: process.env.CHAT_SELF_ORIGIN, PORT: process.env.PORT };

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetChatEnvForTests();
});

describe("chat module env", () => {
  it("accepts loopback CHAT_SELF_ORIGIN values and treats empty as unset", () => {
    for (const origin of ["http://127.0.0.1:4000", "http://localhost:3000", "http://[::1]:3000"]) {
      expect(chatEnvSchema.parse({ CHAT_SELF_ORIGIN: origin }).CHAT_SELF_ORIGIN).toBe(origin);
    }
    expect(chatEnvSchema.parse({ CHAT_SELF_ORIGIN: "" }).CHAT_SELF_ORIGIN).toBeUndefined();
  });

  it("rejects an off-host or malformed CHAT_SELF_ORIGIN", () => {
    expect(chatEnvSchema.safeParse({ CHAT_SELF_ORIGIN: "https://evil.example" }).success).toBe(
      false,
    );
    expect(chatEnvSchema.safeParse({ CHAT_SELF_ORIGIN: "not a url" }).success).toBe(false);
  });

  it("derives the self origin from PORT when unset, and parses once", () => {
    delete process.env.CHAT_SELF_ORIGIN;
    process.env.PORT = "4321";
    expect(getChatEnv().selfOrigin).toBe("http://127.0.0.1:4321");
    process.env.PORT = "9999";
    expect(getChatEnv().selfOrigin).toBe("http://127.0.0.1:4321");
  });

  it("throws on first read when CHAT_SELF_ORIGIN is off-host", () => {
    process.env.CHAT_SELF_ORIGIN = "http://10.0.0.5:3000";
    expect(() => getChatEnv()).toThrow(/loopback/);
  });
});
