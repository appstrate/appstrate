// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import codexModule, { decodeCodexJwtPayload } from "../../index.ts";

describe("codex module", () => {
  it("declares exactly the codex provider", () => {
    const defs = codexModule.modelProviders?.() ?? [];
    expect(defs).toHaveLength(1);
    expect(defs[0]?.providerId).toBe("codex");
  });

  it("codex provider keeps the chatgpt.com wire-format quirks", () => {
    const codex = codexModule.modelProviders?.()[0];
    expect(codex?.apiShape).toBe("openai-codex-responses");
    expect(codex?.forceStream).toBe(true);
    expect(codex?.forceStore).toBe(false);
    expect(codex?.defaultBaseUrl).toBe("https://chatgpt.com/backend-api");
    expect(codex?.rewriteUrlPath).toBeUndefined();
  });

  it("OAuth metadata points at the openai authorization server", () => {
    const codex = codexModule.modelProviders?.()[0];
    expect(codex?.authMode).toBe("oauth2");
    expect(codex?.oauth?.authorizationUrl).toBe("https://auth.openai.com/oauth/authorize");
    expect(codex?.oauth?.tokenUrl).toBe("https://auth.openai.com/oauth/token");
    expect(codex?.oauth?.refreshUrl).toBe("https://auth.openai.com/oauth/token");
    expect(codex?.oauth?.pkce).toBe("S256");
    expect(codex?.oauth?.scopes).toEqual(["openid", "profile", "email"]);
  });

  it("exposes a non-empty model catalog with recommended seeds", () => {
    const codex = codexModule.modelProviders?.()[0];
    expect(codex?.models.length).toBeGreaterThan(0);
    const recommended = codex?.models.filter((m) => m.recommended).map((m) => m.id);
    expect(recommended).toEqual(["gpt-5.5", "gpt-5.4-mini"]);
  });
});

describe("extractTokenIdentity hook", () => {
  function encodeJwt(payload: Record<string, unknown>): string {
    const b64 = (s: string) =>
      Buffer.from(s, "utf-8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    return [
      b64(JSON.stringify({ alg: "RS256" })),
      b64(JSON.stringify(payload)),
      "fake-signature",
    ].join(".");
  }

  it("maps chatgpt_account_id → accountId + passes email through", () => {
    const token = encodeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-uuid" },
      email: "user@example.com",
    });
    const codex = codexModule.modelProviders?.()[0];
    expect(codex?.hooks?.extractTokenIdentity?.(token)).toEqual({
      accountId: "acct-uuid",
      email: "user@example.com",
    });
  });

  it("omits slots absent from the payload (no undefined values leak)", () => {
    const token = encodeJwt({ email: "only-email@example.com" });
    const codex = codexModule.modelProviders?.()[0];
    const out = codex?.hooks?.extractTokenIdentity?.(token);
    expect(out).toEqual({ email: "only-email@example.com" });
    expect(out).not.toHaveProperty("accountId");
  });

  it("returns null on a malformed token", () => {
    const codex = codexModule.modelProviders?.()[0];
    expect(codex?.hooks?.extractTokenIdentity?.("not.a.jwt")).toBeNull();
    expect(codex?.hooks?.extractTokenIdentity?.("a.b.c.d")).toBeNull();
  });

  it("buildApiKeyPlaceholder returns a synthetic JWT carrying only chatgpt_account_id", () => {
    const token = encodeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-1234" },
    });
    const codex = codexModule.modelProviders?.()[0];
    const placeholder = codex?.hooks?.buildApiKeyPlaceholder?.(token);
    expect(placeholder).toBeTruthy();
    const parts = placeholder!.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[2]).toBe("placeholder");
    const payload = JSON.parse(
      Buffer.from(
        parts[1]!.replace(/-/g, "+").replace(/_/g, "/") +
          "=".repeat((4 - (parts[1]!.length % 4)) % 4),
        "base64",
      ).toString("utf-8"),
    ) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"] as Record<string, unknown>;
    expect(auth.chatgpt_account_id).toBe("acct-1234");
  });

  it("buildApiKeyPlaceholder returns null when accountId can't be decoded", () => {
    const codex = codexModule.modelProviders?.()[0];
    expect(codex?.hooks?.buildApiKeyPlaceholder?.("not.a.jwt")).toBeNull();
    expect(codex?.hooks?.buildApiKeyPlaceholder?.(encodeJwt({}))).toBeNull();
  });

  it("decodeCodexJwtPayload re-export stays available for legacy consumers", () => {
    const token = encodeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "x" },
      email: "y@z",
    });
    expect(decodeCodexJwtPayload(token)).toEqual({
      chatgpt_account_id: "x",
      email: "y@z",
    });
  });
});
