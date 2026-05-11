// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  _deriveKeyPlaceholderForTesting as deriveKeyPlaceholder,
  _deriveOauthPlaceholderForTesting as deriveOauthPlaceholder,
} from "../../src/services/run-launcher/pi.ts";

function buildCodexJwt(accountId: string, extraSignatureChars = ""): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }), "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      email: "user@example.com",
      iat: 0,
      exp: 9_999_999_999,
    }),
    "utf-8",
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const sig = "abc-def-ghi-jkl-mno-pqr-stu-vwx-yz0-123-456-789-abc-def" + extraSignatureChars;
  return `${header}.${payload}.${sig}`;
}

function decodePayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  expect(parts).toHaveLength(3);
  const padded = parts[1]! + "=".repeat((4 - (parts[1]!.length % 4)) % 4);
  const json = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
    "utf-8",
  );
  return JSON.parse(json) as Record<string, unknown>;
}

describe("deriveOauthPlaceholder", () => {
  describe("Codex (RS256 JWT)", () => {
    const ACCOUNT_ID = "11111111-2222-3333-4444-555555555555";

    it("returns a structurally valid 3-segment JWT", () => {
      const jwt = buildCodexJwt(ACCOUNT_ID);
      const placeholder = deriveOauthPlaceholder(jwt, "codex");
      expect(placeholder.split(".")).toHaveLength(3);
    });

    it("preserves chatgpt_account_id in the synthetic payload", () => {
      const jwt = buildCodexJwt(ACCOUNT_ID);
      const placeholder = deriveOauthPlaceholder(jwt, "codex");
      const payload = decodePayload(placeholder);
      const auth = payload["https://api.openai.com/auth"] as Record<string, unknown>;
      expect(auth.chatgpt_account_id).toBe(ACCOUNT_ID);
    });

    it("does not leak ANY of the original signature material", () => {
      const sentinel = "SENSITIVESIGSEGMENT";
      const jwt = buildCodexJwt(ACCOUNT_ID, sentinel);
      const placeholder = deriveOauthPlaceholder(jwt, "codex");
      expect(placeholder).not.toContain(sentinel);
    });

    it("uses a recognisable fake signature", () => {
      const jwt = buildCodexJwt(ACCOUNT_ID);
      const placeholder = deriveOauthPlaceholder(jwt, "codex");
      const sig = placeholder.split(".")[2];
      expect(sig).toBe("placeholder");
    });

    it("does not include the original JWT header bytes", () => {
      const jwt = buildCodexJwt(ACCOUNT_ID);
      const originalHeader = jwt.split(".")[0]!;
      const placeholder = deriveOauthPlaceholder(jwt, "codex");
      const placeholderHeader = placeholder.split(".")[0]!;
      // Real Codex header advertises RS256, synthetic header advertises "none".
      expect(placeholderHeader).not.toBe(originalHeader);
      const decodedHeader = JSON.parse(
        Buffer.from(
          placeholderHeader.replace(/-/g, "+").replace(/_/g, "/") +
            "=".repeat((4 - (placeholderHeader.length % 4)) % 4),
          "base64",
        ).toString("utf-8"),
      );
      expect(decodedHeader.alg).toBe("none");
    });

    it("falls back to the legacy placeholder when JWT cannot be decoded", () => {
      const placeholder = deriveOauthPlaceholder("not-a-jwt", "codex");
      expect(placeholder).toBe(deriveKeyPlaceholder("not-a-jwt"));
    });

    it("falls back when chatgpt_account_id is missing from claims", () => {
      const header = "eyJhbGciOiJSUzI1NiJ9";
      const payload = Buffer.from(JSON.stringify({ sub: "x" }), "utf-8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const jwt = `${header}.${payload}.sig`;
      const placeholder = deriveOauthPlaceholder(jwt, "codex");
      expect(placeholder).toBe(deriveKeyPlaceholder(jwt));
    });

    it("returns sk-placeholder when input is undefined", () => {
      const placeholder = deriveOauthPlaceholder(undefined, "codex");
      expect(placeholder).toBe("sk-placeholder");
    });
  });

  describe("non-Codex OAuth providers (opaque bearer tokens)", () => {
    it("delegates to deriveKeyPlaceholder for any non-Codex providerId", () => {
      const token = "sk-some-oauth-DEADBEEFCAFEBABE";
      // Any non-codex providerId follows the generic dash-stripping path.
      const placeholder = deriveOauthPlaceholder(token, "some-external-provider");
      expect(placeholder).toBe(deriveKeyPlaceholder(token));
      expect(placeholder).not.toContain("DEADBEEFCAFEBABE");
    });
  });
});
