// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Stripe contract suite — LIVE, opt-in.
 *
 * The EE billing suite talks to a hand-written mock (`packages/module-ee/
 * test/helpers/stripe.ts`). That mock proves what the module SENDS: every
 * request is recorded and asserted. It cannot prove what Stripe RETURNS, or
 * what Stripe does with what we sent — those responses are fixtures we wrote,
 * so they agree with us by construction and keep agreeing after Stripe has
 * moved on.
 *
 * They have already drifted once. Stripe relocated the billing-cycle end into
 * the subscription ITEM in the 2025-03-31 API version; the mock kept returning
 * it at the top level, where the real API no longer has it at all. Production
 * reads the item (`subscriptionPeriodEnd`, module-ee/src/stripe/webhooks.ts),
 * so against the mock that read is permanently `undefined` and the confirmation
 * email silently falls back to today's date. Nothing failed. Nothing could:
 * the fixture and the assertion were written from the same belief.
 *
 * This suite is the missing half. It hits real Stripe in TEST MODE and checks
 * the two things a mock structurally cannot:
 *
 *   1. Shape — every key path the mock claims exists must exist on the live
 *      object. Extra live fields are fine (the fixtures are deliberately
 *      minimal); invented ones are not. This is the check that turns the next
 *      drift into a red mock instead of a quiet production lie.
 *   2. Semantics — the handful of behaviours the module bets on, above all
 *      that `subscriptions.update` REPLACES the priced item instead of adding
 *      one. A mock returns whatever we told it to; only Stripe can say whether
 *      that call double-charges every customer who changes plan.
 *
 * Coverage is opt-in, following `scripts/conformance/probes.ts`: no
 * `STRIPE_LIVE_SECRET_KEY`, no run, no noise. It is deliberately NOT
 * `STRIPE_SECRET_KEY` — a developer `.env` holding a working key must never
 * make `bun test` start creating objects in an account nobody aimed at.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import Stripe from "stripe";
import {
  defaultCheckoutResponse,
  defaultCustomerResponse,
  defaultPortalResponse,
  defaultSubscriptionResponse,
} from "../helpers/stripe.ts";

const SECRET_KEY = process.env.STRIPE_LIVE_SECRET_KEY;

// The account is mutated (customer + subscription created and torn down), so a
// live key is refused outright rather than skipped: a skip on a mis-set secret
// reads as "covered" in CI, and the cost of being wrong here is real money.
if (SECRET_KEY && !SECRET_KEY.startsWith("sk_test_")) {
  throw new Error(
    "STRIPE_LIVE_SECRET_KEY must be a TEST-mode key (sk_test_…). " +
      "This suite creates and cancels subscriptions.",
  );
}

/**
 * Every key path in `mock` that is absent from `live`, or present with a
 * different JSON type. Walks the MOCK, not the live object: the fixtures carry
 * only the fields the module reads, and the live object carries dozens more.
 * Arrays are compared at index 0 — the fixtures never assert beyond the first
 * element, and neither does production.
 */
function driftedPaths(mock: unknown, live: unknown, prefix = ""): string[] {
  const kind = (v: unknown): string =>
    v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

  if (kind(mock) !== "object" && kind(mock) !== "array") {
    return kind(mock) === kind(live) ? [] : [`${prefix} (mock ${kind(mock)}, live ${kind(live)})`];
  }

  if (Array.isArray(mock)) {
    if (!Array.isArray(live)) return [`${prefix} (mock array, live ${kind(live)})`];
    if (mock.length === 0) return [];
    if (live.length === 0) return [`${prefix}[0] (live array is empty)`];
    return driftedPaths(mock[0], live[0], `${prefix}[0]`);
  }

  const liveRecord = live as Record<string, unknown> | null;
  if (kind(live) !== "object" || liveRecord === null) {
    return [`${prefix} (mock object, live ${kind(live)})`];
  }

  return Object.entries(mock as Record<string, unknown>).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in liveRecord)) return [`${path} (absent from the live object)`];
    return driftedPaths(value, liveRecord[key], path);
  });
}

/** Value at a dotted path, `[0]` segments included. `undefined` when absent. */
function at(root: unknown, path: string): unknown {
  return path
    .split(".")
    .flatMap((seg) => seg.split(/\[(\d+)\]/).filter(Boolean))
    .reduce<unknown>((node, seg) => {
      if (node === null || typeof node !== "object") return undefined;
      return (node as Record<string, unknown>)[seg];
    }, root);
}

describe.skipIf(!SECRET_KEY)("Stripe live contract", () => {
  // Built in `beforeAll`, not here: `describe.skipIf` still evaluates this
  // body, and the Stripe constructor throws on an empty key — which would turn
  // the intended silent skip into a red file on every machine without the
  // secret, i.e. all of them.
  let stripe: Stripe;

  let customer: Stripe.Customer;
  let subscription: Stripe.Subscription;
  let starterPriceId: string;
  let proPriceId: string | null = null;

  beforeAll(async () => {
    stripe = new Stripe(SECRET_KEY!, { apiVersion: "2026-08-26.dahlia" });

    // Prices come from the account rather than from env: `requirements.ts`
    // force-overrides STRIPE_PRICE_ID_* for the mocked suite, so reading those
    // here would send `price_starter_test` to the real API.
    const prices = await stripe.prices.list({ type: "recurring", active: true, limit: 2 });
    if (prices.data.length === 0) {
      throw new Error(
        "No active recurring price in the test account — this suite needs one to subscribe to.",
      );
    }
    starterPriceId = prices.data[0]!.id;
    proPriceId = prices.data[1]?.id ?? null;

    customer = await stripe.customers.create({
      email: "contract-suite@example.test",
      metadata: { orgId: "00000000-0000-4000-a000-00000000c0de" },
    });
    const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: pm.id },
    });
    subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: starterPriceId }],
      metadata: { orgId: "00000000-0000-4000-a000-00000000c0de", planId: "starter" },
    });
  });

  afterAll(async () => {
    // Deleting the customer cancels its subscriptions, but cancel first so a
    // failed delete still leaves nothing billable behind.
    if (subscription) await stripe.subscriptions.cancel(subscription.id).catch(() => {});
    if (customer) await stripe.customers.del(customer.id).catch(() => {});
  });

  // ─── 1. Shape: the mock may not invent fields ─────────────────

  describe("mock fixtures match the live response shape", () => {
    it("subscription", () => {
      expect(driftedPaths(defaultSubscriptionResponse(subscription.id), subscription)).toEqual([]);
    });

    it("customer", () => {
      expect(driftedPaths(defaultCustomerResponse(), customer)).toEqual([]);
    });

    it("checkout session", async () => {
      const session = await stripe.checkout.sessions.create({
        customer: customer.id,
        mode: "subscription",
        line_items: [{ price: starterPriceId, quantity: 1 }],
        success_url: "https://example.test/org-settings/billing",
        cancel_url: "https://example.test/org-settings/billing",
      });
      expect(driftedPaths(defaultCheckoutResponse(), session)).toEqual([]);
    });

    it("billing portal session", async () => {
      const session = await stripe.billingPortal.sessions.create({
        customer: customer.id,
        return_url: "https://example.test/org-settings/billing",
      });
      expect(driftedPaths(defaultPortalResponse(), session)).toEqual([]);
    });
  });

  // ─── 2. Shape: production's reads must land on both sides ─────

  // Every path `packages/module-ee/src` dereferences on a retrieved
  // subscription. Asserted against the LIVE object and the MOCK alike: a path
  // that exists in only one of them is a test suite proving nothing.
  const SUBSCRIPTION_READS = [
    "id",
    "status",
    "customer",
    "metadata",
    "cancel_at_period_end",
    "items.data[0].id",
    "items.data[0].price.id",
    "items.data[0].current_period_end",
  ];

  describe("the fields production reads exist", () => {
    for (const path of SUBSCRIPTION_READS) {
      it(`live subscription has ${path}`, () => {
        expect(at(subscription, path)).toBeDefined();
      });

      it(`mock subscription has ${path}`, () => {
        expect(at(defaultSubscriptionResponse("sub_shape"), path)).toBeDefined();
      });
    }
  });

  // ─── 3. Semantics: what only the real API can settle ──────────

  it("current_period_end is a unix timestamp on the item", () => {
    const ts = subscription.items.data[0]?.current_period_end;
    expect(typeof ts).toBe("number");
    // Sanity, not precision: a seconds/milliseconds mix-up is the failure mode
    // that would otherwise sail through as a date in the year 58000.
    expect(new Date((ts as number) * 1000).getUTCFullYear()).toBeLessThan(2100);
  });

  it("subscriptions.update REPLACES the priced item instead of adding one", async () => {
    if (!proPriceId) {
      throw new Error(
        "The test account has only one active recurring price — a plan change cannot be exercised.",
      );
    }
    const itemId = subscription.items.data[0]!.id;

    const updated = await stripe.subscriptions.update(subscription.id, {
      items: [{ id: itemId, price: proPriceId }],
      proration_behavior: "create_prorations",
    });

    // The invariant `packages/module-ee/src/stripe/plan.ts` bets the business
    // on: without the item id, this call ADDS a second priced item and every
    // plan change starts billing twice.
    expect(updated.items.data).toHaveLength(1);
    expect(updated.items.data[0]!.price.id).toBe(proPriceId);
  });

  it("accepts a valid webhook signature and rejects a forged one", async () => {
    const payload = JSON.stringify({
      id: "evt_contract",
      object: "event",
      type: "customer.subscription.updated",
      data: { object: { id: subscription.id, object: "subscription" } },
    });
    const secret = "whsec_contract_suite";

    const header = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
    const event = await stripe.webhooks.constructEventAsync(payload, header, secret);
    expect(event.type).toBe("customer.subscription.updated");

    // `apps`-side error handling keys off this exact class (module-ee/src/
    // routes/billing.ts) to answer 400 rather than 500.
    await expect(
      stripe.webhooks.constructEventAsync(payload, "t=1,v1=deadbeef", secret),
    ).rejects.toBeInstanceOf(Stripe.errors.StripeSignatureVerificationError);
  });

  it("raises StripeInvalidRequestError for an unknown subscription", async () => {
    await expect(stripe.subscriptions.retrieve("sub_does_not_exist_xyz")).rejects.toBeInstanceOf(
      Stripe.errors.StripeInvalidRequestError,
    );
  });
});
