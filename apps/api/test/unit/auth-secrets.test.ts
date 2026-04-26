import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  signAuthHmac,
  verifyAuthHmac,
  getActiveAuthSecret,
  _resetAuthSecretsCache,
} from "../../src/lib/auth-secrets.ts";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";

function resetCaches(): void {
  resetEnvCache();
  _resetAuthSecretsCache();
}

const ENV_KEYS = ["BETTER_AUTH_SECRET", "BETTER_AUTH_ACTIVE_KID", "BETTER_AUTH_SECRETS"] as const;

function snapshotEnv(): Record<(typeof ENV_KEYS)[number], string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as Record<
    (typeof ENV_KEYS)[number],
    string | undefined
  >;
}

function restoreEnv(snap: ReturnType<typeof snapshotEnv>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

describe("auth-secrets", () => {
  let snap: ReturnType<typeof snapshotEnv>;

  beforeEach(() => {
    snap = snapshotEnv();
  });

  afterEach(() => {
    restoreEnv(snap);
    resetCaches();
  });

  describe("backward-compat: single BETTER_AUTH_SECRET", () => {
    beforeEach(() => {
      process.env.BETTER_AUTH_SECRET = "legacy-single-secret-32-chars-long";
      delete process.env.BETTER_AUTH_SECRETS;
      delete process.env.BETTER_AUTH_ACTIVE_KID;
      resetCaches();
    });

    it("uses BETTER_AUTH_SECRET as the active secret", () => {
      expect(getActiveAuthSecret()).toBe("legacy-single-secret-32-chars-long");
    });

    it("signs with prefixed kid format", () => {
      const sig = signAuthHmac("payload");
      expect(sig.startsWith("k1$")).toBe(true);
    });

    it("verifies its own prefixed signature", () => {
      const sig = signAuthHmac("payload");
      expect(verifyAuthHmac("payload", sig)).toBe(true);
    });

    it("verifies a legacy un-prefixed signature against the active secret", () => {
      const sig = signAuthHmac("payload");
      const legacy = sig.split("$")[1]!;
      expect(verifyAuthHmac("payload", legacy)).toBe(true);
    });
  });

  describe("rotation: active kid + secrets map", () => {
    beforeEach(() => {
      process.env.BETTER_AUTH_SECRET = "fallback-not-used-32-chars-long";
      process.env.BETTER_AUTH_ACTIVE_KID = "k2";
      process.env.BETTER_AUTH_SECRETS = JSON.stringify({
        k1: "old-secret-32-chars-long-for-hmac",
        k2: "new-secret-32-chars-long-for-hmac",
      });
      resetCaches();
    });

    it("returns the active secret", () => {
      expect(getActiveAuthSecret()).toBe("new-secret-32-chars-long-for-hmac");
    });

    it("signs with the active kid", () => {
      const sig = signAuthHmac("payload");
      expect(sig.startsWith("k2$")).toBe(true);
    });

    it("verifies signatures from a previous kid", async () => {
      // Simulate a cookie signed before rotation by k1.
      const { createHmac } = await import("node:crypto");
      const hmac = createHmac("sha256", "old-secret-32-chars-long-for-hmac")
        .update("payload")
        .digest("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      expect(verifyAuthHmac("payload", `k1$${hmac}`)).toBe(true);
    });

    it("rejects an unknown kid", () => {
      expect(verifyAuthHmac("payload", "k99$ZZZ")).toBe(false);
    });

    it("rejects a tampered signature under a known kid", () => {
      expect(verifyAuthHmac("payload", "k1$AAAA")).toBe(false);
    });
  });
});
