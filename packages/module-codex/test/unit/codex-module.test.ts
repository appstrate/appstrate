// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import codexModule from "../../src/index.ts";

describe("codex module", () => {
  it("declares exactly the codex provider", () => {
    const defs = codexModule.modelProviders?.() ?? [];
    expect(defs).toHaveLength(1);
    expect(defs[0]?.providerId).toBe("codex");
  });

  it("codex provider targets the chatgpt.com responses shape but declares no forge", () => {
    const codex = codexModule.modelProviders?.()[0] as Record<string, unknown>;
    expect(codex.apiShape).toBe("openai-codex-responses");
    expect(codex.defaultBaseUrl).toBe("https://chatgpt.com/backend-api");
    // Forging is removed: the provider no longer carries a sidecar/chat
    // wire-format forge. Codex stays connectable (its self-contained probe) but
    // is non-executable (no run/chat engine) until it migrates to its own SDK.
    expect(codex.oauthWireFormat).toBeUndefined();
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

  it("exposes a non-empty featured catalog", () => {
    const codex = codexModule.modelProviders?.()[0];
    expect(codex?.featuredModels).toEqual(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
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
});

describe("validateCredential hook", () => {
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

  const codex = () => codexModule.modelProviders?.()[0];
  const ACCOUNT = "acct-uuid";
  const withAccount = (extra: Record<string, unknown> = {}) =>
    encodeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT }, ...extra });

  it("rejects a token missing chatgpt_account_id", () => {
    const out = codex()?.hooks?.validateCredential?.({ apiKey: encodeJwt({ exp: 9_999_999_999 }) });
    expect(out?.ok).toBe(false);
    expect(out?.error).toBe("AUTH_FAILED");
  });

  it("rejects a token with NO expiry source (no row expiresAt, no exp claim)", () => {
    // Has the required account id but neither an `exp` claim nor a row expiresAt:
    // expiry is unverifiable offline → must be rejected, not accepted.
    const out = codex()?.hooks?.validateCredential?.({ apiKey: withAccount() });
    expect(out?.ok).toBe(false);
    expect(out?.error).toBe("AUTH_FAILED");
    expect(out?.message).toMatch(/expiry could not be verified/i);
  });

  it("rejects an expired token (via exp claim)", () => {
    const out = codex()?.hooks?.validateCredential?.({ apiKey: withAccount({ exp: 1 }) });
    expect(out?.ok).toBe(false);
    expect(out?.error).toBe("AUTH_FAILED");
    expect(out?.message).toMatch(/expired/i);
  });

  it("accepts a token with an unexpired exp claim", () => {
    const out = codex()?.hooks?.validateCredential?.({
      apiKey: withAccount({ exp: 9_999_999_999 }),
    });
    expect(out?.ok).toBe(true);
  });

  it("accepts a token with an unexpired row expiresAt (exp claim absent)", () => {
    const out = codex()?.hooks?.validateCredential?.({
      apiKey: withAccount(),
      expiresAt: Date.now() + 60_000,
    });
    expect(out?.ok).toBe(true);
  });

  it("rejects when the row expiresAt has passed (exp claim absent)", () => {
    const out = codex()?.hooks?.validateCredential?.({
      apiKey: withAccount(),
      expiresAt: Date.now() - 60_000,
    });
    expect(out?.ok).toBe(false);
    expect(out?.message).toMatch(/expired/i);
  });
});
