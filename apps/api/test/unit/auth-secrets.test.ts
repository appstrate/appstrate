// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { signAuthHmac, verifyAuthHmac } from "../../src/lib/auth-secrets.ts";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";

const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS"] as const;

const SINGLE = "single-secret-32-chars-long-for-hmac";
const OLD = "old-secret-32-chars-long-for-hmac";
const NEW = "new-secret-32-chars-long-for-hmac";

function hmac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function setEnv(vars: Record<(typeof ENV_KEYS)[number], string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  resetEnvCache();
}

describe("auth-secrets", () => {
  let snap: Record<(typeof ENV_KEYS)[number], string | undefined>;

  beforeEach(() => {
    snap = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as typeof snap;
  });

  afterEach(() => {
    setEnv(snap);
  });

  describe("no keyring: BETTER_AUTH_SECRET alone", () => {
    beforeEach(() => {
      setEnv({ BETTER_AUTH_SECRET: SINGLE, BETTER_AUTH_SECRETS: undefined });
    });

    it("signs with BETTER_AUTH_SECRET, as a bare signature", () => {
      expect(signAuthHmac("payload")).toBe(hmac(SINGLE, "payload"));
    });

    it("verifies its own signature", () => {
      expect(verifyAuthHmac("payload", signAuthHmac("payload"))).toBe(true);
    });

    it("rejects a signature under an unknown secret", () => {
      expect(verifyAuthHmac("payload", hmac(NEW, "payload"))).toBe(false);
    });
  });

  describe("keyring: BETTER_AUTH_SECRETS", () => {
    beforeEach(() => {
      setEnv({ BETTER_AUTH_SECRET: SINGLE, BETTER_AUTH_SECRETS: `2:${NEW},1:${OLD}` });
    });

    it("signs with the first keyring secret", () => {
      expect(signAuthHmac("payload")).toBe(hmac(NEW, "payload"));
    });

    it("verifies a signature under any keyring secret", () => {
      expect(verifyAuthHmac("payload", hmac(NEW, "payload"))).toBe(true);
      expect(verifyAuthHmac("payload", hmac(OLD, "payload"))).toBe(true);
    });

    it("rejects BETTER_AUTH_SECRET once a keyring is set", () => {
      expect(verifyAuthHmac("payload", hmac(SINGLE, "payload"))).toBe(false);
    });

    it("rejects a tampered signature and a signature over another payload", () => {
      expect(verifyAuthHmac("payload", "AAAA")).toBe(false);
      expect(verifyAuthHmac("other", hmac(OLD, "payload"))).toBe(false);
    });
  });
});
