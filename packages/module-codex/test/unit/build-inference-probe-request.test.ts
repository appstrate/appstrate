// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the Codex OFFLINE credential validation — the
 * connection-test path. Goes through the `validateCredential` hook (the
 * same entry point the platform's `testModelConfig` uses); no
 * module-private exports.
 *
 * Compliance invariant (B1): the platform issues ZERO Codex API calls to
 * test a credential. `validateCredential` is a pure local JWT decode — no
 * network. These tests pin: (a) it accepts a structurally valid, unexpired
 * Codex JWT; (b) it rejects a token missing `chatgpt_account_id`; (c) it
 * rejects an expired token; and (d) the provider declares
 * `credentialValidation: "offline"` so the platform skips the network probe.
 */

import { describe, it, expect } from "bun:test";
import codexModule from "../../src/index.ts";
import { base64UrlEncode } from "@appstrate/core/jwt";
import type { CredentialValidationResult } from "@appstrate/core/module";

const codex = codexModule.modelProviders?.()[0];

/** Build a Codex-shaped JWT (alg:none — signature ignored by the decoder). */
function codexJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${header}.${body}.sig`;
}

function validate(args: {
  apiKey: string;
  accountId?: string;
  expiresAt?: number | null;
}): CredentialValidationResult | undefined {
  return codex?.hooks?.validateCredential?.(args);
}

describe("codex offline credential validation", () => {
  it("declares credentialValidation: 'offline' and NO buildInferenceProbe", () => {
    expect(codex?.credentialValidation).toBe("offline");
    expect(codex?.hooks?.validateCredential).toBeFunction();
    // The forging probe machinery is deleted.
    expect((codex?.hooks as Record<string, unknown>).buildInferenceProbe).toBeUndefined();
  });

  it("accepts a structurally valid, unexpired Codex JWT", () => {
    const token = codexJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acc-uuid" },
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(validate({ apiKey: token })).toEqual({ ok: true });
  });

  it("accepts when the credential row carries a future expiresAt (token has no exp)", () => {
    const token = codexJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acc-uuid" },
    });
    expect(validate({ apiKey: token, expiresAt: Date.now() + 60_000 })).toEqual({ ok: true });
  });

  it("rejects a token missing chatgpt_account_id (AUTH_FAILED)", () => {
    const token = codexJwt({ email: "u@example.com" });
    const out = validate({ apiKey: token });
    expect(out?.ok).toBe(false);
    if (out?.ok === false) {
      expect(out.error).toBe("AUTH_FAILED");
      expect(out.message).toContain("chatgpt-account-id");
    }
  });

  it("rejects a non-JWT token (AUTH_FAILED)", () => {
    const out = validate({ apiKey: "not-a-jwt" });
    expect(out?.ok).toBe(false);
    if (out?.ok === false) expect(out.error).toBe("AUTH_FAILED");
  });

  it("rejects a token expired via its own exp claim", () => {
    const token = codexJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acc-uuid" },
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    const out = validate({ apiKey: token });
    expect(out?.ok).toBe(false);
    if (out?.ok === false) {
      expect(out.error).toBe("AUTH_FAILED");
      expect(out.message).toContain("expired");
    }
  });

  it("rejects when the credential row's expiresAt is in the past (overrides a future exp)", () => {
    const token = codexJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acc-uuid" },
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const out = validate({ apiKey: token, expiresAt: Date.now() - 1 });
    expect(out?.ok).toBe(false);
  });
});
