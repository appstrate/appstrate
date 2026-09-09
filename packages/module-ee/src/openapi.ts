// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * OpenAPI 3.1 contribution for the EE module.
 *
 * Surfaced through `AppstrateModule.openApiPaths()` / `openApiTags()` /
 * `openApiComponentSchemas()` so the assembled platform spec exposes the
 * billing endpoints when EE is loaded. Disabled deployments contribute
 * nothing — the zero-footprint invariant holds.
 */

import { CHECKOUT_PLAN_IDS, PLAN_IDS } from "./config.ts";

const billingAccountSchemaRef = { $ref: "#/components/schemas/EeBillingAccount" } as const;
const billingPlanSchemaRef = { $ref: "#/components/schemas/EeBillingPlan" } as const;
const billingUpgradePlanRef = { $ref: "#/components/schemas/EeBillingUpgradePlan" } as const;
const checkoutPlanIdRef = { $ref: "#/components/schemas/EeCheckoutPlanId" } as const;
// EE errors use the platform's shared RFC 9457 Problem Details schema
// (contributed by core), so the billing surface matches the rest of the API.
const errorProblemRef = { $ref: "#/components/schemas/ProblemDetail" } as const;
const billingManagerSchemaRef = { $ref: "#/components/schemas/EeBillingManager" } as const;
const billingManagerListRef = { $ref: "#/components/schemas/EeBillingManagerList" } as const;
const billingContactSchemaRef = { $ref: "#/components/schemas/EeBillingContact" } as const;

export function openApiTags() {
  return [
    {
      name: "Billing",
      description: "Stripe-backed billing surface contributed by `@appstrate/module-ee`.",
    },
  ];
}

export function openApiComponentSchemas(): Record<string, unknown> {
  return {
    EeCheckoutPlanId: {
      type: "string",
      enum: [...CHECKOUT_PLAN_IDS],
      description:
        "A plan `POST /api/billing/checkout` accepts. Strictly narrower than a catalog `EeBillingPlan.id`: `free` has no Stripe price, so it is not a checkout target.",
    },
    EeBillingPlan: {
      type: "object",
      required: ["id", "name", "price", "credit_quota", "file_storage_bytes"],
      properties: {
        id: { type: "string", enum: [...PLAN_IDS] },
        name: { type: "string", description: 'Display name (e.g. "Free", "Starter")' },
        price: { type: "number", description: "Monthly price in dollars" },
        credit_quota: { type: "integer", description: "Credits granted per billing cycle" },
        file_storage_bytes: {
          type: "integer",
          description:
            "Durable-file storage the plan grants, in bytes — the value projected onto the org's platform storage limit.",
        },
      },
    },
    // The intersection is what carries the narrowing to a client: a caller that
    // reads `upgrades[i].id` gets a checkout id, not a catalog id, so handing
    // it to `POST /api/billing/checkout` needs no guard on the way.
    EeBillingUpgradePlan: {
      allOf: [
        billingPlanSchemaRef,
        { type: "object", required: ["id"], properties: { id: checkoutPlanIdRef } },
      ],
      description:
        "A catalog plan the org can upgrade into — an `EeBillingPlan` whose `id` is narrowed to a checkout target.",
    },
    EeBillingManager: {
      type: "object",
      required: ["user_id", "added_by", "created_at"],
      properties: {
        user_id: {
          type: "string",
          description: "Platform user id granted `billing:read` + `billing:manage`.",
        },
        added_by: { type: "string", description: "User id that granted it." },
        created_at: { type: "string", format: "date-time" },
      },
    },
    EeBillingManagerList: {
      type: "object",
      required: ["managers"],
      properties: {
        managers: { type: "array", items: billingManagerSchemaRef },
      },
    },
    EeBillingContact: {
      type: "object",
      required: ["billing_email", "billing_cc"],
      properties: {
        billing_email: {
          type: ["string", "null"],
          format: "email",
          description:
            "Primary billing address. `null` falls back to the organization's owners, resolved at send time.",
        },
        billing_cc: {
          type: "array",
          maxItems: 5,
          items: { type: "string", format: "email" },
          description: "Addresses copied on every billing email.",
        },
      },
    },
    EeBillingAccount: {
      type: "object",
      required: [
        "plan",
        "plans",
        "usage_percent",
        "credits_used",
        "credit_quota",
        "period_end",
        "status",
        "plan_action",
        "upgrades",
      ],
      properties: {
        plan: {
          type: "object",
          required: ["id", "name"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
          },
        },
        plans: { type: "array", items: billingPlanSchemaRef },
        usage_percent: { type: "integer", minimum: 0, maximum: 100 },
        credits_used: { type: "integer" },
        credit_quota: { type: "integer" },
        period_end: { type: ["string", "null"], format: "date-time" },
        status: {
          type: "string",
          description:
            "Effective billing status. `none` when no Stripe subscription is attached, `canceling` while a subscription Stripe still collects on is set to end at the period boundary, otherwise mirrors Stripe's `subscription.status`.",
          enum: [
            "none",
            "active",
            "trialing",
            "past_due",
            "unpaid",
            "paused",
            "incomplete",
            "canceled",
            "canceling",
          ],
        },
        plan_action: {
          type: "string",
          description:
            "Which endpoint a plan selection goes to: `plan-change` for `POST /api/billing/plan`, `portal` for `POST /api/billing/portal` when Stripe holds the subscription but has stopped collecting on it, `checkout` for `POST /api/billing/checkout`. Checkout only creates, so an org Stripe holds a subscription for never re-enters it — a second one would bill the customer twice.",
          enum: ["plan-change", "portal", "checkout"],
        },
        upgrades: {
          type: "array",
          description: "Plans the org can upgrade into — empty when on the highest plan.",
          items: billingUpgradePlanRef,
        },
      },
    },
  };
}

export function openApiPaths(): Record<string, unknown> {
  return {
    "/api/billing": {
      get: {
        operationId: "getEeBillingAccount",
        tags: ["Billing"],
        summary: "Get the current org's billing account",
        description:
          "Returns the org's current plan, credit usage, subscription status, and available upgrade tiers. Requires `billing:read` (granted to every org member).",
        parameters: [{ $ref: "#/components/parameters/XOrgId" }],
        responses: {
          "200": {
            description: "Billing snapshot",
            content: { "application/json": { schema: billingAccountSchemaRef } },
          },
          "403": {
            description: "Caller lacks `billing:read`",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
          "404": {
            description: "No billing account exists for this org",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
        },
      },
    },
    "/api/billing/checkout": {
      post: {
        operationId: "createEeBillingCheckoutSession",
        tags: ["Billing"],
        summary: "Create a Stripe Checkout session",
        description:
          "Returns a one-time Stripe Checkout URL the dashboard redirects to. Admin-only (`billing:manage`). Rate-limited to 5/min per org.",
        parameters: [{ $ref: "#/components/parameters/XOrgId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["plan_id"],
                additionalProperties: false,
                properties: {
                  plan_id: checkoutPlanIdRef,
                  return_url: {
                    type: "string",
                    description:
                      "Path-relative redirect target (must start with `/`). Defaults to `/org-settings/billing`.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Checkout session URL",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["url"],
                  properties: { url: { type: "string", format: "uri" } },
                },
              },
            },
          },
          "400": {
            description: "Validation error or invalid Stripe plan configuration",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
          "403": {
            description: "Caller lacks `billing:manage`",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
          "404": {
            description: "No billing account exists for this org",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
          "409": {
            description:
              "The organization already has a subscription (`subscription_exists`) — change its plan with `POST /api/billing/plan` instead of starting a second one.",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
          "429": {
            description: "Rate-limited (5/min per org) or Stripe-side rate limit",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
          "503": {
            description: "Stripe unavailable",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
        },
      },
    },
    "/api/billing/plan": {
      post: {
        operationId: "changeEeBillingPlan",
        tags: ["Billing"],
        summary: "Change the plan of the existing subscription",
        description:
          "Moves the organization's EXISTING Stripe subscription onto another plan, in place, with proration — the door for an org that already subscribes, where `POST /api/billing/checkout` would create a second subscription and bill it twice. Admin-only (`billing:manage`). Rate-limited to 5/min per org. Returns the billing snapshot; the new plan itself is applied when Stripe's `customer.subscription.updated` arrives, so the returned `plan` may still name the previous one.",
        parameters: [{ $ref: "#/components/parameters/XOrgId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["plan_id"],
                additionalProperties: false,
                properties: { plan_id: checkoutPlanIdRef },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Billing snapshot after the change was sent to Stripe",
            content: { "application/json": { schema: billingAccountSchemaRef } },
          },
          "400": {
            description: "Validation error or invalid Stripe plan configuration",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
          "403": {
            description: "Caller lacks `billing:manage`",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
          "404": {
            description: "No billing account exists for this org",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
          "409": {
            description:
              "The organization has no subscription to change (`no_active_subscription`) — start a checkout instead.",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
          "429": {
            description: "Rate-limited (5/min per org) or Stripe-side rate limit",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
          "503": {
            description: "Stripe unavailable",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
        },
      },
    },
    "/api/billing/portal": {
      post: {
        operationId: "createEeBillingPortalSession",
        tags: ["Billing"],
        summary: "Create a Stripe Customer Portal session",
        description:
          "Returns a one-time Stripe Customer Portal URL the dashboard redirects to (manage payment method, cancel subscription, view invoices). Admin-only (`billing:manage`). Rate-limited to 5/min per org.",
        parameters: [{ $ref: "#/components/parameters/XOrgId" }],
        responses: {
          "200": {
            description: "Customer portal URL",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["url"],
                  properties: { url: { type: "string", format: "uri" } },
                },
              },
            },
          },
          "403": {
            description: "Caller lacks `billing:manage`",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
          "429": {
            description: "Rate-limited (5/min per org)",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
          "503": {
            description: "Stripe unavailable",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
        },
      },
    },
    "/api/billing/managers": {
      get: {
        operationId: "listEeBillingManagers",
        tags: ["Billing"],
        summary: "List the organization's billing managers",
        description:
          "Org users granted `billing:read` + `billing:manage` without being owners or admins. Requires `billing:manage`.",
        parameters: [{ $ref: "#/components/parameters/XOrgId" }],
        responses: {
          "200": {
            description: "The billing managers, oldest grant first",
            content: { "application/json": { schema: billingManagerListRef } },
          },
          "403": {
            description: "Caller lacks `billing:manage`",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
        },
      },
      put: {
        operationId: "replaceEeBillingManagers",
        tags: ["Billing"],
        summary: "Replace the organization's billing managers",
        description:
          "Replaces the whole set with `user_ids`. Every id must be a member of the organization, and none may be an owner or admin — those already hold `billing:*` through their org role, so listing them would grant nothing while making the list read as if they were the only ones who could. Requires `billing:manage`.",
        parameters: [{ $ref: "#/components/parameters/XOrgId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["user_ids"],
                additionalProperties: false,
                properties: {
                  user_ids: {
                    type: "array",
                    items: { type: "string", minLength: 1 },
                    description: "The complete set of billing managers. An empty array clears it.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The resulting billing managers",
            content: { "application/json": { schema: billingManagerListRef } },
          },
          "400": {
            description: "A user id is not an org member, or is an owner/admin",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
          "403": {
            description: "Caller lacks `billing:manage`",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
        },
      },
    },
    "/api/billing/contact": {
      get: {
        operationId: "getEeBillingContact",
        tags: ["Billing"],
        summary: "Get the billing contact",
        description:
          "The address invoices, receipts and payment alerts are sent to, plus the CC list. Requires `billing:manage`.",
        parameters: [{ $ref: "#/components/parameters/XOrgId" }],
        responses: {
          "200": {
            description: "Billing contact",
            content: { "application/json": { schema: billingContactSchemaRef } },
          },
          "403": {
            description: "Caller lacks `billing:manage`",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
          "404": {
            description: "No billing account exists for this org",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
        },
      },
      patch: {
        operationId: "updateEeBillingContact",
        tags: ["Billing"],
        summary: "Update the billing contact",
        description:
          "Sets `billing_email` and/or `billing_cc`; omitted fields are left as they are, and `billing_email: null` clears the contact so it falls back to the organization's owners. The primary address is pushed to the Stripe customer so Stripe addresses its own receipts. Requires `billing:manage`.",
        parameters: [{ $ref: "#/components/parameters/XOrgId" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  billing_email: { type: ["string", "null"], format: "email" },
                  billing_cc: {
                    type: "array",
                    maxItems: 5,
                    items: { type: "string", format: "email" },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The resulting billing contact",
            content: { "application/json": { schema: billingContactSchemaRef } },
          },
          "400": {
            description: "Invalid email address, or more than 5 CC addresses",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
          "403": {
            description: "Caller lacks `billing:manage`",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
          "404": {
            description: "No billing account exists for this org",
            content: { "application/problem+json": { schema: errorProblemRef } },
          },
        },
      },
    },
    "/api/billing/webhooks": {
      post: {
        operationId: "receiveEeBillingStripeWebhook",
        tags: ["Billing"],
        summary: "Stripe webhook receiver",
        description:
          "Stripe-signed webhook receiver. Public path (no platform auth) — verified by `Stripe-Signature` header against `STRIPE_WEBHOOK_SECRET`. Idempotent via `ee_stripe_events`.",
        security: [],
        parameters: [
          {
            name: "Stripe-Signature",
            in: "header",
            required: true,
            schema: { type: "string" },
            description: "HMAC signature emitted by Stripe with each webhook delivery.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                description:
                  "Raw Stripe event payload — schema dictated by Stripe's API and intentionally left open here.",
                additionalProperties: true,
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Webhook accepted",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["received"],
                  properties: { received: { type: "boolean" } },
                },
              },
            },
          },
          "400": {
            description: "Missing or invalid Stripe signature",
            content: { "text/plain": { schema: { type: "string" } } },
          },
          "500": {
            description: "Webhook processing error",
            content: { "text/plain": { schema: { type: "string" } } },
          },
        },
      },
    },
  };
}
