// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, expect, it } from "bun:test";
import { getEeEnv, _resetEeEnvForTests } from "../../src/env.ts";

describe("env", () => {
  describe("getEeEnv()", () => {
    it("returns a valid EeEnv object with all required fields", () => {
      const env = getEeEnv();
      expect(env.STRIPE_SECRET_KEY).toBeString();
      expect(env.STRIPE_WEBHOOK_SECRET).toBeString();
      expect(env.STRIPE_PRICE_ID_STARTER).toBeString();
      expect(env.STRIPE_PRICE_ID_PRO).toBeString();
    });

    it("returns the test values set by preload", () => {
      const env = getEeEnv();
      expect(env.STRIPE_SECRET_KEY).toBe("sk_test_fake_key_for_testing");
      expect(env.STRIPE_WEBHOOK_SECRET).toBe("whsec_test_secret_for_webhook_verification");
      expect(env.STRIPE_PRICE_ID_STARTER).toBe("price_starter_test");
      expect(env.STRIPE_PRICE_ID_PRO).toBe("price_pro_test");
    });

    it("returns the same cached reference on subsequent calls", () => {
      const first = getEeEnv();
      const second = getEeEnv();
      expect(first).toBe(second);
    });

    it("has non-empty string values for all fields", () => {
      const env = getEeEnv();
      expect(env.STRIPE_SECRET_KEY.length).toBeGreaterThan(0);
      expect(env.STRIPE_WEBHOOK_SECRET.length).toBeGreaterThan(0);
      expect(env.STRIPE_PRICE_ID_STARTER.length).toBeGreaterThan(0);
      expect(env.STRIPE_PRICE_ID_PRO.length).toBeGreaterThan(0);
    });

    it("returns an object containing the required Stripe keys plus reconciliation tunables", () => {
      const env = getEeEnv();
      expect(Object.keys(env)).toEqual(
        expect.arrayContaining([
          "STRIPE_SECRET_KEY",
          "STRIPE_WEBHOOK_SECRET",
          "STRIPE_PRICE_ID_STARTER",
          "STRIPE_PRICE_ID_PRO",
          "EE_RECONCILIATION_INTERVAL_SECONDS",
          "EE_RECONCILIATION_BATCH_SIZE",
          "EE_RECONCILIATION_REPLAY_WINDOW",
        ]),
      );
    });

    it("applies sensible defaults to reconciliation env vars when unset", () => {
      const env = getEeEnv();
      expect(env.EE_RECONCILIATION_INTERVAL_SECONDS).toBeGreaterThanOrEqual(0);
      expect(env.EE_RECONCILIATION_BATCH_SIZE).toBeGreaterThan(0);
    });

    it("defaults the replay window to a non-zero value on an unconfigured deployment", () => {
      // The window closes a SILENT revenue loss, so it must be on by default —
      // an operator who never heard of the var still gets the fix. Preload sets
      // no value for it, so this reads the schema default.
      const env = getEeEnv();
      expect(env.EE_RECONCILIATION_REPLAY_WINDOW).toBe(200);
    });

    it("bounds the replay window so it can never starve the forward batch", () => {
      // A pass reads `replaySpan + BATCH_SIZE` capped at the platform's 1000-row
      // ceiling, so a window above 500 could leave a maxed-out batch with less
      // forward capacity than replay. Capping at 500 keeps forward progress
      // structural rather than dependent on operator discipline.
      const parse = (value: string): boolean => {
        process.env.EE_RECONCILIATION_REPLAY_WINDOW = value;
        _resetEeEnvForTests();
        try {
          getEeEnv();
          return true;
        } catch {
          return false;
        }
      };
      try {
        expect(parse("500")).toBe(true);
        expect(parse("501")).toBe(false);
        expect(parse("-1")).toBe(false);
        // 0 stays legal: the escape hatch back to the plain cursor.
        expect(parse("0")).toBe(true);
      } finally {
        delete process.env.EE_RECONCILIATION_REPLAY_WINDOW;
        _resetEeEnvForTests();
      }
    });
  });
});
