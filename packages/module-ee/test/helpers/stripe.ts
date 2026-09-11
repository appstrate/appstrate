// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Stripe mock server and webhook helpers for EE module tests.
 *
 * Uses Bun.serve on port 0 (OS-assigned) to mock all Stripe API endpoints
 * used by the EE billing module. Supports response overrides, error
 * injection, and request recording for assertions.
 */

import type Stripe from "stripe";

// ─── Typed fixtures ─────────────────────────────────────────────

/**
 * A minimal stand-in for a live Stripe object.
 *
 * Every field a fixture carries must exist on the real SDK type with a
 * compatible type; the fixture is free to omit the dozens of fields production
 * never reads. This is the half of the contract check that needs no Stripe key:
 * when a bump of `stripe` RELOCATES a field — as 2025-03-31 did with
 * `current_period_end`, and post-basil did with `invoice.subscription` —
 * `tsc` fails on the fixture instead of letting it keep agreeing with itself.
 *
 * `test/live/stripe-contract.test.ts` is the other half: it proves the fields
 * the fixtures DO carry still exist on a real response.
 */
export type Fixture<T> = T extends (infer U)[]
  ? Fixture<U>[]
  : T extends object
    ? { [K in keyof T]?: Fixture<T[K]> }
    : T;

// ─── Request recording ──────────────────────────────────────────

interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

export const requests: RecordedRequest[] = [];

function clearRequests(): void {
  requests.length = 0;
}

// ─── Response overrides ─────────────────────────────────────────

let checkoutOverride: Record<string, unknown> | null = null;
type SubscriptionResponse =
  Fixture<Stripe.Subscription> | (() => Promise<Fixture<Stripe.Subscription>>);
let subscriptionOverride: SubscriptionResponse | null = null;
let nextError: { status: number; body: Record<string, unknown> } | null = null;

export function setCheckoutResponse(response: Record<string, unknown>): void {
  checkoutOverride = response;
}

/**
 * Answer the next `GET /v1/subscriptions/:id` (retrieve) with `response`. Retrieve ONLY:
 * the in-place plan change retrieves then updates the same subscription, so an override
 * both verbs consumed would be spent by the retrieve and never reach the update.
 */
export function setSubscriptionResponse(response: SubscriptionResponse): void {
  subscriptionOverride = response;
}

export function setNextError(status: number, body: Record<string, unknown>): void {
  nextError = { status, body };
}

function resetOverrides(): void {
  checkoutOverride = null;
  subscriptionOverride = null;
  nextError = null;
}

export function resetStripeMock(): void {
  clearRequests();
  resetOverrides();
}

// ─── Body parsing ───────────────────────────────────────────────

async function parseBody(req: Request): Promise<Record<string, unknown> | null> {
  const contentType = req.headers.get("content-type") ?? "";
  const raw = await req.text();
  if (!raw) return null;

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(raw);
    const obj: Record<string, unknown> = {};
    for (const [key, value] of params.entries()) {
      obj[key] = value;
    }
    return obj;
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { _raw: raw };
  }
}

// ─── Default responses ──────────────────────────────────────────

let customerCounter = 0;

export function defaultCustomerResponse(): Fixture<Stripe.Customer> {
  customerCounter++;
  return {
    id: `cus_test_${customerCounter.toString().padStart(3, "0")}`,
    object: "customer",
    metadata: {},
  };
}

export function defaultCheckoutResponse(): Fixture<Stripe.Checkout.Session> {
  return {
    id: `cs_test_${Date.now()}`,
    url: "https://checkout.stripe.com/test",
    object: "checkout.session",
  };
}

export function defaultPortalResponse(): Fixture<Stripe.BillingPortal.Session> {
  return {
    id: `bps_test_${Date.now()}`,
    url: "https://billing.stripe.com/test",
    object: "billing_portal.session",
  };
}

export function defaultSubscriptionResponse(id: string): Fixture<Stripe.Subscription> {
  return {
    id,
    object: "subscription",
    status: "active",
    items: {
      object: "list",
      data: [
        {
          id: "si_test_001",
          price: { id: "price_starter_test", product: "prod_test" },
          // On the ITEM, not the subscription: Stripe moved the billing cycle
          // end here in the 2025-03-31 API version, and the top-level field is
          // gone from the live response. `subscriptionPeriodEnd` (src/stripe/
          // webhooks.ts) reads this path; while the fixture kept the old
          // placement that read returned `undefined` in every test and the
          // confirmation email silently fell back to today's date.
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        },
      ],
    },
    // Always an object on the live API, empty when unset. Production calls
    // `parseStripeMetadata` on it during budget allocation, so the path has to
    // be here even when the values are not.
    metadata: {},
    cancel_at_period_end: false,
    customer: "cus_test_001",
  };
}

/**
 * The invoice `packages/module-ee/src/stripe/webhooks.ts` receives on
 * `invoice.paid` and `invoice.payment_failed`.
 *
 * One place writes `parent.subscription_details.subscription` — the post-basil
 * replacement for the removed top-level `invoice.subscription`, and the single
 * path that decides whether budget allocation happens at all. Spelling it at
 * every call site is how the module ended up with a subscription reference no
 * test could disprove; spelling it once, typed as `Fixture<Stripe.Invoice>`,
 * makes the next relocation a typecheck failure.
 */
export function invoiceEventObject(opts: {
  id: string;
  customer: string;
  /** `null` for the "invoice with no subscription reference" path. */
  subscription: string | null;
  billingReason?: Stripe.Invoice.BillingReason;
  amountPaid?: number;
  amountDue?: number;
  attemptCount?: number;
  hostedInvoiceUrl?: string;
}): Fixture<Stripe.Invoice> {
  // Written as direct properties, never conditional spreads: TypeScript exempts
  // spread properties from excess-property checking, so a field that Stripe has
  // moved would slip back in unnoticed through `...(cond ? {} : { gone: x })`.
  // `JSON.stringify` drops the `undefined` ones, so the wire payload still
  // carries only what the case under test sets.
  return {
    id: opts.id,
    object: "invoice",
    customer: opts.customer,
    billing_reason: opts.billingReason ?? "subscription_cycle",
    parent:
      opts.subscription === null
        ? null
        : { subscription_details: { subscription: opts.subscription } },
    amount_paid: opts.amountPaid,
    amount_due: opts.amountDue,
    attempt_count: opts.attemptCount,
    hosted_invoice_url: opts.hostedInvoiceUrl,
  };
}

/**
 * The invoice fixture with every optional field set.
 *
 * `invoiceEventObject` leaves unset fields out of the wire payload so each
 * mocked test carries only what it exercises; the contract checks need the
 * union of all of them, because the question there is whether the SHAPE the
 * builder can produce still matches Stripe — not what one test happens to send.
 */
export function fullInvoiceFixture(): Fixture<Stripe.Invoice> {
  return invoiceEventObject({
    id: "in_shape",
    customer: "cus_shape",
    subscription: "sub_shape",
    billingReason: "subscription_cycle",
    amountPaid: 2900,
    amountDue: 2900,
    attemptCount: 1,
    hostedInvoiceUrl: "https://invoice.stripe.com/i/test",
  });
}

// ─── What production reads off each object ──────────────────────

/**
 * Every path `packages/module-ee/src` dereferences on a retrieved subscription.
 *
 * Held here rather than in either test file because BOTH halves need it: the
 * key-free half (`test/unit/stripe-fixtures.test.ts`) asserts the fixtures carry
 * these paths, and the live half (`test/live/stripe-contract.test.ts`) asserts
 * Stripe still does. A path that resolves on only one side is a suite proving
 * nothing.
 */
export const SUBSCRIPTION_READS = [
  "id",
  "status",
  "customer",
  "metadata",
  "cancel_at_period_end",
  "items.data[0].id",
  "items.data[0].price.id",
  "items.data[0].current_period_end",
];

/**
 * Every path `src/stripe/webhooks.ts` dereferences on an invoice, across
 * `invoice.paid` and `invoice.payment_failed`.
 *
 * `parent.subscription_details.subscription` is the one that matters most: post-
 * basil it replaced the removed top-level `invoice.subscription`, and when it
 * reads `undefined` budget allocation is skipped outright rather than failing.
 */
export const INVOICE_READS = [
  "id",
  "customer",
  "billing_reason",
  "amount_paid",
  "amount_due",
  "attempt_count",
  "hosted_invoice_url",
  "parent.subscription_details.subscription",
];

/** Value at a dotted path, `[0]` segments included. `undefined` when absent. */
export function valueAtPath(root: unknown, path: string): unknown {
  return path
    .split(".")
    .flatMap((seg) => seg.split(/\[(\d+)\]/).filter(Boolean))
    .reduce<unknown>((node, seg) => {
      if (node === null || typeof node !== "object") return undefined;
      return (node as Record<string, unknown>)[seg];
    }, root);
}

// ─── Mock server ────────────────────────────────────────────────

let server: ReturnType<typeof Bun.serve> | null = null;

export function startStripeMock(): { port: number } {
  if (server) return { port: server.port! };

  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const method = req.method;
      const path = url.pathname;
      const body = await parseBody(req);

      requests.push({ method, path, body });

      // Error injection — consumes the override
      if (nextError) {
        const err = nextError;
        nextError = null;
        return Response.json(err.body, { status: err.status });
      }

      // POST /v1/customers
      if (method === "POST" && path === "/v1/customers") {
        return Response.json(defaultCustomerResponse());
      }

      // POST /v1/customers/:id — customer update (billing contact push)
      if (method === "POST" && path.startsWith("/v1/customers/")) {
        const id = path.split("/").pop()!;
        return Response.json({ id, object: "customer", ...body });
      }

      // DELETE /v1/customers/:id
      if (method === "DELETE" && path.startsWith("/v1/customers/")) {
        const id = path.split("/").pop()!;
        return Response.json({ id, object: "customer", deleted: true });
      }

      // POST /v1/checkout/sessions
      if (method === "POST" && path === "/v1/checkout/sessions") {
        const response = checkoutOverride ?? defaultCheckoutResponse();
        checkoutOverride = null;
        return Response.json(response);
      }

      // POST /v1/billing_portal/sessions
      if (method === "POST" && path === "/v1/billing_portal/sessions") {
        return Response.json(defaultPortalResponse());
      }

      // GET /v1/subscriptions/:id
      if (method === "GET" && path.startsWith("/v1/subscriptions/")) {
        const id = path.split("/").pop()!;
        const response = subscriptionOverride ?? defaultSubscriptionResponse(id);
        subscriptionOverride = null;
        return Response.json(typeof response === "function" ? await response() : response);
      }

      // POST /v1/subscriptions/:id — subscription update (in-place plan change).
      // Never reads the retrieve override; see `setSubscriptionResponse`.
      if (method === "POST" && path.startsWith("/v1/subscriptions/")) {
        const id = path.split("/").pop()!;
        return Response.json(defaultSubscriptionResponse(id));
      }

      // DELETE /v1/subscriptions/:id
      if (method === "DELETE" && path.startsWith("/v1/subscriptions/")) {
        const id = path.split("/").pop()!;
        return Response.json({ id, object: "subscription", status: "canceled" });
      }

      // Fallback for unhandled routes
      return Response.json(
        { error: { type: "invalid_request_error", message: `Unhandled: ${method} ${path}` } },
        { status: 404 },
      );
    },
  });

  return { port: server.port! };
}

// ─── Webhook signature generation ───────────────────────────────

/**
 * Generate a signed Stripe webhook event payload.
 * Computes HMAC-SHA256 manually (Bun's SubtleCryptoProvider doesn't support
 * the synchronous path used by Stripe.webhooks.generateTestHeaderString).
 */
export function generateWebhookEvent(
  payload: object,
  secret: string,
): { body: string; signature: string } {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${body}`;
  const hmac = new Bun.CryptoHasher("sha256", secret);
  hmac.update(signedPayload);
  const sig = hmac.digest("hex");
  const signature = `t=${timestamp},v1=${sig}`;
  return { body, signature };
}
