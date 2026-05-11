// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { decodeCodexJwtPayload } from "../../../src/services/oauth-model-providers/registry.ts";

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
