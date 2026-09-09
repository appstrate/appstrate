// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Stripe mock server and webhook helpers for EE module tests.
 *
 * Uses Bun.serve on port 0 (OS-assigned) to mock all Stripe API endpoints
 * used by the EE billing module. Supports response overrides, error
 * injection, and request recording for assertions.
 */

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
let subscriptionOverride: Record<string, unknown> | null = null;
let nextError: { status: number; body: Record<string, unknown> } | null = null;

export function setCheckoutResponse(response: Record<string, unknown>): void {
  checkoutOverride = response;
}

/**
 * Answer the next `GET /v1/subscriptions/:id` (retrieve) with `response`. Retrieve ONLY:
 * the in-place plan change retrieves then updates the same subscription, so an override
 * both verbs consumed would be spent by the retrieve and never reach the update.
 */
export function setSubscriptionResponse(response: Record<string, unknown>): void {
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

function defaultCustomerResponse(): Record<string, unknown> {
  customerCounter++;
  return {
    id: `cus_test_${customerCounter.toString().padStart(3, "0")}`,
    object: "customer",
    metadata: {},
  };
}

function defaultCheckoutResponse(): Record<string, unknown> {
  return {
    id: `cs_test_${Date.now()}`,
    url: "https://checkout.stripe.com/test",
    object: "checkout.session",
  };
}

function defaultPortalResponse(): Record<string, unknown> {
  return {
    id: `bps_test_${Date.now()}`,
    url: "https://billing.stripe.com/test",
    object: "billing_portal.session",
  };
}

function defaultSubscriptionResponse(id: string): Record<string, unknown> {
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
        },
      ],
    },
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    cancel_at_period_end: false,
    customer: "cus_test_001",
  };
}

// ─── Mock server ────────────────────────────────────────────────

let server: ReturnType<typeof Bun.serve> | null = null;

export function startStripeMock(): { port: number } {
  if (server) return { port: server.port };

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
        return Response.json(response);
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

  return { port: server.port };
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
