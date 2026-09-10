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
 * the three things a mock structurally cannot:
 *
 *   1. Shape — every key path the mock claims exists must exist on the live
 *      object, for Subscription, Customer, Checkout.Session,
 *      BillingPortal.Session and Invoice. Extra live fields are fine (the
 *      fixtures are deliberately minimal); invented ones are not. This is the
 *      check that turns the next drift into a red mock instead of a quiet
 *      production lie.
 *   2. Semantics — the handful of behaviours the module bets on, above all
 *      that `subscriptions.update` REPLACES the priced item instead of adding
 *      one. A mock returns whatever we told it to; only Stripe can say whether
 *      that call double-charges every customer who changes plan.
 *   3. Account configuration — that every enabled webhook endpoint renders
 *      payloads at the version this module pins. The SDK pin governs what a
 *      `retrieve` returns; a webhook payload is rendered at the ENDPOINT's
 *      configured version, and `subscriptionPeriodEnd` is applied to
 *      `event.data.object` too.
 *
 * Coverage is opt-in, following `scripts/conformance/probes.ts`: no
 * `STRIPE_LIVE_SECRET_KEY`, no run, no noise. It is deliberately NOT
 * `STRIPE_SECRET_KEY` — a developer `.env` holding a working key must never
 * make `bun test` start creating objects in an account nobody aimed at.
 *
 * Because "no key" is the common case, the checks that do NOT need one live
 * elsewhere and run everywhere: `Fixture<T>` (test/helpers/stripe.ts) types
 * every fixture against the SDK, so a bump that RELOCATES a field fails `tsc`;
 * and `test/unit/stripe-fixtures.test.ts` asserts the fixtures carry every path
 * production reads, which the all-optional `Fixture<T>` cannot.
 *
 * Run it with:
 *
 *   STRIPE_LIVE_SECRET_KEY=sk_test_… bun test packages/module-ee/test/live
 *
 * (`packages/module-ee` declares `postgres: true`, so the harness needs the
 * test infrastructure up even though this file touches no table.)
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import Stripe from "stripe";
import {
  INVOICE_READS,
  SUBSCRIPTION_READS,
  defaultCheckoutResponse,
  defaultCustomerResponse,
  defaultPortalResponse,
  defaultSubscriptionResponse,
  fullInvoiceFixture,
  valueAtPath,
} from "../helpers/stripe.ts";
import { STRIPE_API_VERSION } from "../../src/stripe/client.ts";

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
    // `undefined` is the fixture declining to set the field (the builders spell
    // every key so the typechecker sees them), not a claim about the live shape.
    if (value === undefined) return [];
    if (!(key in liveRecord)) return [`${path} (absent from the live object)`];
    return driftedPaths(value, liveRecord[key], path);
  });
}

describe.skipIf(!SECRET_KEY)("Stripe live contract", () => {
  // Built in `beforeAll`, not here: `describe.skipIf` still evaluates this
  // body, and the Stripe constructor throws on an empty key — which would turn
  // the intended silent skip into a red file on every machine without the
  // secret, i.e. all of them.
  let stripe: Stripe;

  let customer: Stripe.Customer;
  let subscription: Stripe.Subscription;
  let invoice: Stripe.Invoice;
  let starterPriceId: string;
  let proPriceId: string | null = null;

  beforeAll(async () => {
    // The pin comes from production (src/stripe/client.ts), never from a
    // literal restated here: a second copy in a file `tsc` drags forward on its
    // own schedule is how a suite ends up validating an API version production
    // stopped speaking at the previous SDK bump.
    stripe = new Stripe(SECRET_KEY!, { apiVersion: STRIPE_API_VERSION });

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

    // The invoice `invoice.paid` / `invoice.payment_failed` carry. Fetched
    // rather than mocked because the field budget allocation hangs on —
    // `parent.subscription_details.subscription` — is a post-basil RELOCATION
    // of the removed top-level `invoice.subscription`, and a relocation is
    // exactly what a fixture cannot notice about itself.
    const invoiceRef = subscription.latest_invoice;
    if (!invoiceRef) {
      throw new Error(
        "The subscription came back with no latest_invoice — the account cannot charge the attached card.",
      );
    }
    invoice = await stripe.invoices.retrieve(
      typeof invoiceRef === "string" ? invoiceRef : invoiceRef.id!,
    );
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

    it("invoice", () => {
      expect(driftedPaths(fullInvoiceFixture(), invoice)).toEqual([]);
    });
  });

  // ─── 2. Shape: production's reads must land on the LIVE object ─

  // The mirror half — that the FIXTURES carry these same paths — is
  // `test/unit/stripe-fixtures.test.ts`, which needs no key and therefore runs
  // everywhere. A path resolving on only one of the two sides is a suite
  // proving nothing, which is why the lists live in `test/helpers/stripe.ts`
  // and neither file restates them.

  describe("the fields production reads exist on Stripe", () => {
    for (const path of SUBSCRIPTION_READS) {
      it(`live subscription has ${path}`, () => {
        expect(valueAtPath(subscription, path)).toBeDefined();
      });
    }

    for (const path of INVOICE_READS) {
      it(`live invoice has ${path}`, () => {
        expect(valueAtPath(invoice, path)).toBeDefined();
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

  it("every webhook endpoint renders payloads at the version the module pins", async () => {
    // The SDK pin governs what `subscriptions.retrieve` RETURNS. It does not
    // govern webhook payloads: those are rendered at the version configured on
    // the endpoint. `subscriptionPeriodEnd` is applied to `event.data.object`
    // too (src/stripe/webhooks.ts), so an endpoint left at 2025-03-31 reads a
    // `current_period_end` that has since moved onto the item — and `periodEnd`
    // silently stops updating on `customer.subscription.updated`.
    //
    // `api_version: null` means "the account default", which is not pinned to
    // anything this repository can see, so it counts as a mismatch.
    const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
    const mismatched = endpoints.data
      .filter((e) => e.status === "enabled" && e.api_version !== STRIPE_API_VERSION)
      .map((e) => `${e.url} (${e.api_version ?? "account default"})`);

    expect(mismatched).toEqual([]);
  });

  it("raises StripeInvalidRequestError for an unknown subscription", async () => {
    await expect(stripe.subscriptions.retrieve("sub_does_not_exist_xyz")).rejects.toBeInstanceOf(
      Stripe.errors.StripeInvalidRequestError,
    );
  });
});
