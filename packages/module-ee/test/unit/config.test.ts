// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, expect, it } from "bun:test";
import {
  getPlans,
  GIB,
  ENDED_SUBSCRIPTION_STATUSES,
  HARD_BLOCKED_STATUSES,
  HELD_SUBSCRIPTION_STATUSES,
  LIVE_SUBSCRIPTION_STATUSES,
  planAction,
  WARNING_STATUSES,
  ESTIMATED_MODEL_CREDITS_PER_RUN,
  ESTIMATED_MODEL_CREDITS_PER_CHAT_TURN,
  COMPUTE_CREDITS_PER_RUN_SECOND,
  COMPUTE_CREDITS_PER_CHAT_TURN,
  DEFAULT_QUOTE_RATES,
} from "../../src/config.ts";

describe("config", () => {
  describe("getPlans()", () => {
    it("returns 3 plans: free, starter, pro", () => {
      const plans = getPlans();
      expect(plans.free).toBeDefined();
      expect(plans.starter).toBeDefined();
      expect(plans.pro).toBeDefined();
    });

    it("free plan has 5000 credits quota, null stripePriceId, tier 0", () => {
      const { free } = getPlans();
      expect(free.id).toBe("free");
      expect(free.name).toBe("Free");
      expect(free.tier).toBe(0);
      expect(free.creditQuota).toBe(5000);
      expect(free.fileStorageBytes).toBe(1 * GIB);
      expect(free.monthlyPrice).toBe(0);
      expect(free.stripePriceId).toBeNull();
    });

    it("starter plan has correct price, credit quota, and tier", () => {
      const { starter } = getPlans();
      expect(starter.id).toBe("starter");
      expect(starter.name).toBe("Starter");
      expect(starter.tier).toBe(1);
      expect(starter.creditQuota).toBe(20000);
      expect(starter.fileStorageBytes).toBe(20 * GIB);
      expect(starter.monthlyPrice).toBe(29);
      expect(starter.stripePriceId).toBe("price_starter_test");
    });

    it("pro plan has correct price, credit quota, and tier", () => {
      const { pro } = getPlans();
      expect(pro.id).toBe("pro");
      expect(pro.name).toBe("Pro");
      expect(pro.tier).toBe(2);
      expect(pro.creditQuota).toBe(80000);
      expect(pro.fileStorageBytes).toBe(100 * GIB);
      expect(pro.monthlyPrice).toBe(99);
      expect(pro.stripePriceId).toBe("price_pro_test");
    });
  });

  describe("subscription admission statuses", () => {
    it("hard-blocks unpaid and paused subscriptions", () => {
      expect(HARD_BLOCKED_STATUSES).toEqual(new Set(["unpaid", "paused"]));
    });

    it("treats canceled and incomplete-expired subscriptions as ended paid entitlements", () => {
      expect(ENDED_SUBSCRIPTION_STATUSES).toEqual(new Set(["canceled", "incomplete_expired"]));
    });

    it("holds every status at which a second checkout would double-bill", () => {
      expect(HELD_SUBSCRIPTION_STATUSES).toEqual(
        new Set(["active", "trialing", "past_due", "unpaid", "paused", "incomplete"]),
      );
    });

    it("moves a plan in place only where Stripe is still collecting", () => {
      expect(LIVE_SUBSCRIPTION_STATUSES).toEqual(new Set(["active", "trialing", "past_due"]));
    });

    it("keeps LIVE a strict subset of HELD", () => {
      // A status a plan change accepts but a checkout does not refuse would let one org
      // hold two subscriptions at once.
      for (const status of LIVE_SUBSCRIPTION_STATUSES) {
        expect(HELD_SUBSCRIPTION_STATUSES.has(status)).toBe(true);
      }
      expect(LIVE_SUBSCRIPTION_STATUSES.size).toBeLessThan(HELD_SUBSCRIPTION_STATUSES.size);
    });
  });

  describe("planAction", () => {
    it("sends a live subscription to the in-place plan change", () => {
      for (const status of LIVE_SUBSCRIPTION_STATUSES) {
        expect(planAction({ stripeSubscriptionId: "sub_1", subscriptionStatus: status })).toBe(
          "plan-change",
        );
      }
    });

    it("sends a held-but-uncollected subscription to the Customer Portal", () => {
      for (const status of ["unpaid", "paused", "incomplete"]) {
        expect(planAction({ stripeSubscriptionId: "sub_1", subscriptionStatus: status })).toBe(
          "portal",
        );
      }
    });

    it("sends an account Stripe holds nothing for to checkout", () => {
      expect(planAction({ stripeSubscriptionId: null, subscriptionStatus: null })).toBe("checkout");
      expect(planAction({ stripeSubscriptionId: "sub_dead", subscriptionStatus: "canceled" })).toBe(
        "checkout",
      );
      // A dead id with no status: only `customer.subscription.deleted` nulls the
      // column, so this row is what a lost one leaves behind.
      expect(planAction({ stripeSubscriptionId: "sub_dead", subscriptionStatus: null })).toBe(
        "checkout",
      );
    });
  });

  describe("WARNING_STATUSES", () => {
    it("contains past_due, unpaid, paused", () => {
      expect(WARNING_STATUSES.has("past_due")).toBe(true);
      expect(WARNING_STATUSES.has("unpaid")).toBe(true);
      expect(WARNING_STATUSES.has("paused")).toBe(true);
      expect(WARNING_STATUSES.has("active")).toBe(false);
    });
  });

  describe("ESTIMATED_MODEL_CREDITS_PER_RUN", () => {
    it("is 200 credits", () => {
      expect(ESTIMATED_MODEL_CREDITS_PER_RUN).toBe(200);
    });
  });

  describe("ESTIMATED_MODEL_CREDITS_PER_CHAT_TURN", () => {
    it("is 20 credits (smaller than a run — a chat turn is short-lived)", () => {
      expect(ESTIMATED_MODEL_CREDITS_PER_CHAT_TURN).toBe(20);
      expect(ESTIMATED_MODEL_CREDITS_PER_CHAT_TURN).toBeLessThan(ESTIMATED_MODEL_CREDITS_PER_RUN);
    });
  });

  describe("compute rates", () => {
    it("ship at 0 — platform compute is not charged in phase 1", () => {
      expect(COMPUTE_CREDITS_PER_RUN_SECOND).toBe(0);
      expect(COMPUTE_CREDITS_PER_CHAT_TURN).toBe(0);
    });
  });

  describe("DEFAULT_QUOTE_RATES", () => {
    it("assembles the four production rates in one place", () => {
      expect(DEFAULT_QUOTE_RATES).toEqual({
        modelCreditsPerRun: ESTIMATED_MODEL_CREDITS_PER_RUN,
        modelCreditsPerChatTurn: ESTIMATED_MODEL_CREDITS_PER_CHAT_TURN,
        computeCreditsPerRunSecond: COMPUTE_CREDITS_PER_RUN_SECOND,
        computeCreditsPerChatTurn: COMPUTE_CREDITS_PER_CHAT_TURN,
      });
    });
  });
});
