// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  decodeCodexJwtPayload,
  readClaudeEmail,
  readClaudeSubscriptionType,
} from "../../../src/services/oauth-model-providers/credentials.ts";

function buildJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  // Signature is irrelevant — decoder doesn't verify it.
  return `${header}.${body}.signature`;
}

describe("decodeCodexJwtPayload", () => {
  it("extracts chatgpt_account_id from the OpenAI auth claim", () => {
    const token = buildJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acc_123abc" },
      email: "user@example.com",
    });
    expect(decodeCodexJwtPayload(token)).toEqual({
      chatgpt_account_id: "acc_123abc",
      email: "user@example.com",
    });
  });

  it("returns undefined fields when claims are missing", () => {
    const token = buildJwt({});
    expect(decodeCodexJwtPayload(token)).toEqual({
      chatgpt_account_id: undefined,
      email: undefined,
    });
  });

  it("returns null for non-JWT strings", () => {
    expect(decodeCodexJwtPayload("not.a.jwt.token.too-many-parts")).toBeNull();
    expect(decodeCodexJwtPayload("plain")).toBeNull();
    expect(decodeCodexJwtPayload("a.b")).toBeNull();
  });

  it("returns null on malformed base64 / JSON payload", () => {
    expect(decodeCodexJwtPayload("aaa.@@@.bbb")).toBeNull();
  });

  it("ignores wrong-shape auth claim (defensive)", () => {
    const token = buildJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: 42 }, // not a string
    });
    expect(decodeCodexJwtPayload(token)?.chatgpt_account_id).toBeUndefined();
  });

  it("handles base64url padding correctly", () => {
    // 1 base64 char short of full block
    const payload = { x: "y" };
    const token = buildJwt(payload);
    expect(decodeCodexJwtPayload(token)).toEqual({
      chatgpt_account_id: undefined,
      email: undefined,
    });
  });
});

describe("readClaudeSubscriptionType", () => {
  it("returns the subscription_type field when present as string", () => {
    expect(readClaudeSubscriptionType({ subscription_type: "pro" })).toBe("pro");
    expect(readClaudeSubscriptionType({ subscription_type: "max" })).toBe("max");
  });

  it("returns undefined when missing or non-string", () => {
    expect(readClaudeSubscriptionType({})).toBeUndefined();
    expect(readClaudeSubscriptionType({ subscription_type: 123 })).toBeUndefined();
  });
});

describe("readClaudeEmail", () => {
  it("reads email from top-level field", () => {
    expect(readClaudeEmail({ email: "user@anthropic.com" })).toBe("user@anthropic.com");
  });

  it("falls back to account.email_address", () => {
    expect(readClaudeEmail({ account: { email_address: "user@org.com" } })).toBe("user@org.com");
  });

  it("returns undefined when neither is present", () => {
    expect(readClaudeEmail({})).toBeUndefined();
    expect(readClaudeEmail({ account: {} })).toBeUndefined();
  });
});
