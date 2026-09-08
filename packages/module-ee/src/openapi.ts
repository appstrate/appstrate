// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI 3.1 contribution for the cloud module.
 *
 * Surfaced through `AppstrateModule.openApiPaths()` / `openApiTags()` /
 * `openApiComponentSchemas()` so the assembled platform spec exposes the
 * billing endpoints when cloud is loaded. Disabled deployments contribute
 * nothing — the zero-footprint invariant holds.
 */

const billingAccountSchemaRef = { $ref: "#/components/schemas/CloudBillingAccount" } as const;
const billingPlanSchemaRef = { $ref: "#/components/schemas/CloudBillingPlan" } as const;
// Cloud errors use the platform's shared RFC 9457 Problem Details schema
// (contributed by core), so the billing surface matches the rest of the API.
const errorProblemRef = { $ref: "#/components/schemas/ProblemDetail" } as const;
const billingManagerSchemaRef = { $ref: "#/components/schemas/CloudBillingManager" } as const;
const billingManagerListRef = { $ref: "#/components/schemas/CloudBillingManagerList" } as const;
const billingContactSchemaRef = { $ref: "#/components/schemas/CloudBillingContact" } as const;

export function openApiTags() {
  return [
    {
      name: "Cloud Billing",
      description: "Stripe-backed billing surface contributed by @appstrate/cloud.",
    },
  ];
}

export function openApiComponentSchemas(): Record<string, unknown> {
  return {
    CloudBillingPlan: {
      type: "object",
      required: ["id", "name", "price", "credit_quota", "file_storage_bytes"],
      properties: {
        id: { type: "string", enum: ["free", "starter", "pro"] },
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
    CloudBillingManager: {
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
    CloudBillingManagerList: {
      type: "object",
      required: ["managers"],
      properties: {
        managers: { type: "array", items: billingManagerSchemaRef },
      },
    },
    CloudBillingContact: {
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
    CloudBillingAccount: {
      type: "object",
      required: [
        "plan",
        "plans",
        "usage_percent",
        "credits_used",
        "credit_quota",
        "period_end",
        "status",
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
            "Effective billing status. `none` when no Stripe subscription is attached, `canceling` during the period-end grace window, otherwise mirrors Stripe's `subscription.status`.",
          enum: [
            "none",
            "active",
            "trialing",
            "past_due",
            "unpaid",
            "paused",
            "canceled",
            "canceling",
          ],
        },
        upgrades: {
          type: "array",
          description: "Plans the org can upgrade into — empty when on the highest plan.",
          items: billingPlanSchemaRef,
        },
      },
    },
  };
}

export function openApiPaths(): Record<string, unknown> {
  return {
    "/api/billing": {
      get: {
        operationId: "getCloudBillingAccount",
        tags: ["Cloud Billing"],
        summary: "Get the current org's billing account",
        description:
          "Returns the org's current plan, credit usage, subscription status, and available upgrade tiers. Requires `billing:read` (granted to every org member).",
        parameters: [{ $ref: "#/components/parameters/XOrgId" }],
        responses: {
          "200": {
            description: "Billing snapshot",
            content: { "application/json": { schema: billingAccountSchemaRef } },
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
        operationId: "createCloudBillingCheckoutSession",
        tags: ["Cloud Billing"],
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
                properties: {
                  plan_id: { type: "string", enum: ["starter", "pro"] },
                  return_url: {
                    type: "string",
                    description:
                      "Path-relative redirect target (must start with `/`). Defaults to `/settings/billing`.",
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
        operationId: "createCloudBillingPortalSession",
        tags: ["Cloud Billing"],
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
        operationId: "listCloudBillingManagers",
        tags: ["Cloud Billing"],
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
        operationId: "replaceCloudBillingManagers",
        tags: ["Cloud Billing"],
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
                properties: {
                  user_ids: {
                    type: "array",
                    items: { type: "string" },
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
        operationId: "getCloudBillingContact",
        tags: ["Cloud Billing"],
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
        operationId: "updateCloudBillingContact",
        tags: ["Cloud Billing"],
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
        operationId: "receiveCloudBillingStripeWebhook",
        tags: ["Cloud Billing"],
        summary: "Stripe webhook receiver",
        description:
          "Stripe-signed webhook receiver. Public path (no platform auth) — verified by `Stripe-Signature` header against `STRIPE_WEBHOOK_SECRET`. Idempotent via `cloud_stripe_events`.",
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
