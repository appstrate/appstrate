// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, expect, it } from "bun:test";
import {
  LEDGER_LIST_MAX_LIMIT,
  eeEnvSchema,
  describeEnvIssues,
  getEeEnv,
  _resetEeEnvForTests,
} from "../../src/env.ts";
import requirements from "../requirements.ts";
import { applyEeFixtureEnv } from "../helpers/fixture-env.ts";

applyEeFixtureEnv();

describe("env", () => {
  it("pins the platform's usage.list ceiling", () => {
    // Neither side may import the other's constant across the licence boundary,
    // so this pin mirrors `apps/api/test/unit/llm-usage-list-cap.test.ts`.
    expect(LEDGER_LIST_MAX_LIMIT).toBe(1000);
  });

  describe("getEeEnv()", () => {
    it("returns a valid EeEnv object with all required fields", () => {
      const env = getEeEnv();
      expect(env.STRIPE_SECRET_KEY).toBeString();
      expect(env.STRIPE_WEBHOOK_SECRET).toBeString();
      expect(env.STRIPE_PRICE_ID_STARTER).toBeString();
      expect(env.STRIPE_PRICE_ID_PRO).toBeString();
    });

    it("returns the fixture values the module declares for its tests", () => {
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

    it("refuses a batch size the replay window leaves no room for", () => {
      // REGRESSION (#1328). A pass reads `replayWindow + batchSize` rows and the
      // platform caps that read at 1000, so a sum above the ceiling shrinks the
      // FORWARD slice below `batchSize` instead of reading more — and the
      // sweeper's within-tick drain loop, gated on `processed >= batchSize`,
      // then stops after one pass. Raising the batch to clear a backlog made
      // throughput fall, and the "drain cap reached" warning could not fire to
      // say so. Boot has to refuse the combination, not clamp it.
      const parse = (batchSize: string, replayWindow: string) =>
        eeEnvSchema.safeParse({
          ...requirements.env,
          EE_RECONCILIATION_BATCH_SIZE: batchSize,
          EE_RECONCILIATION_REPLAY_WINDOW: replayWindow,
        }).success;
      expect(parse("800", "200")).toBe(true);
      expect(parse("801", "200")).toBe(false);
      expect(parse("1000", "0")).toBe(true);
      expect(parse("501", "500")).toBe(false);
    });

    it("names the batch size when the two reconciliation knobs overrun the read budget", () => {
      const result = eeEnvSchema.safeParse({
        ...requirements.env,
        EE_RECONCILIATION_BATCH_SIZE: "1000",
        EE_RECONCILIATION_REPLAY_WINDOW: "200",
      });
      expect(result.success).toBe(false);
      const message = describeEnvIssues(result.error);
      expect(message).toContain("EE_RECONCILIATION_BATCH_SIZE");
      expect(message).toContain("EE_RECONCILIATION_REPLAY_WINDOW");
    });

    it("bounds the replay window so it can never starve the forward batch", () => {
      // A pass reads `replaySpan + BATCH_SIZE` capped at the platform's 1000-row
      // ceiling, so a window above 500 could leave a maxed-out batch with less
      // forward capacity than replay. The 500 cap is a FLOOR on forward
      // capacity, not the whole guarantee — what makes it exactly BATCH_SIZE is
      // the cross-field rule covered by the test above.
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

describe("describeEnvIssues()", () => {
  it("names every rejected variable and its reason", () => {
    const saved = { ...process.env };
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_SECRET_KEY;
    _resetEeEnvForTests();
    try {
      let message = "";
      try {
        getEeEnv();
      } catch (err) {
        message = describeEnvIssues(err);
      }
      // An operator reading a boot crash needs the variable, not "misconfigured".
      expect(message).toContain("STRIPE_WEBHOOK_SECRET");
      expect(message).toContain("STRIPE_SECRET_KEY");
      expect(message).not.toContain("STRIPE_PRICE_ID_PRO");
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = saved.STRIPE_WEBHOOK_SECRET;
      process.env.STRIPE_SECRET_KEY = saved.STRIPE_SECRET_KEY;
      _resetEeEnvForTests();
    }
  });

  it("passes a non-Zod failure through unchanged", () => {
    expect(describeEnvIssues(new Error("boom"))).toBe("boom");
  });
});
