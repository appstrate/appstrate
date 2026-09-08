// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { Hono, type Context } from "hono";
import Stripe from "stripe";
import { z } from "zod";
import { getEeDb } from "../db.ts";
import { billingAccounts } from "../../drizzle/schema.ts";
import { eq } from "drizzle-orm";
import { createCheckoutSession } from "../stripe/checkout.ts";
import { createPortalSession } from "../stripe/portal.ts";
import { handleWebhook } from "../stripe/webhooks.ts";
import { CHECKOUT_PLAN_IDS, getPlans, WARNING_STATUSES, type PlanDefinition } from "../config.ts";
import { logger } from "../logger.ts";
import { eeRateLimit, eeRequireAdmin, eeRequirePermission } from "../middleware.ts";
import {
  listBillingManagers,
  replaceBillingManagers,
  type BillingManager,
} from "../billing/managers.ts";
import {
  billingContactPatchSchema,
  getBillingContact,
  updateBillingContact,
  MAX_BILLING_CC,
} from "../billing/contact.ts";
import { getOrgQueries } from "../platform-org-queries.ts";
import {
  problemJson,
  noBillingAccount,
  rateLimited,
  paymentServiceUnavailable,
} from "../http-errors.ts";
import { invalidRequest } from "@appstrate/core/api-errors";
import type { OrgRole } from "../types.ts";

// Minimal env type — set by the platform's auth + RBAC middleware. `userId` is
// the session caller: billing-manager grants are attributed to whoever made
// them, and the platform's own `principalPermissions` surface is session-only,
// so a request that reaches a `billing:manage` route always has one.
type EeEnv = {
  Variables: {
    orgId: string;
    orgRole: OrgRole;
    userId: string;
    permissions: ReadonlySet<string>;
  };
};

const KNOWN_STATUSES = new Set([...WARNING_STATUSES, "active", "trialing", "canceled"]);

function getBillingStatus(account: {
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean;
}): string {
  if (!account.stripeSubscriptionId) return "none";
  if (account.cancelAtPeriodEnd) return "canceling";
  if (account.subscriptionStatus && KNOWN_STATUSES.has(account.subscriptionStatus))
    return account.subscriptionStatus;
  return "none";
}

/**
 * Wire projection of a plan definition — the single shape `plans` and
 * `upgrades` both serve, so an entitlement added to one is never missing from
 * the other. `file_storage_bytes` is the durable-file capacity the plan
 * grants (projected onto the platform's per-org storage limit by
 * `syncOrgStorageEntitlement`), so the dashboard can price storage next to
 * credits instead of leaving it invisible until a run hits the limit.
 */
interface PlanDetail {
  id: string;
  name: string;
  price: number;
  credit_quota: number;
  file_storage_bytes: number;
}

type CheckoutPlanId = (typeof CHECKOUT_PLAN_IDS)[number];

/** A plan offered as an upgrade — its id is one `POST /checkout` accepts. */
interface UpgradeDetail extends PlanDetail {
  id: CheckoutPlanId;
}

function planDetail(p: PlanDefinition): PlanDetail {
  return {
    id: p.id,
    name: p.name,
    price: p.monthlyPrice,
    credit_quota: p.creditQuota,
    file_storage_bytes: p.fileStorageBytes,
  };
}

function isCheckoutPlan(p: PlanDefinition): p is PlanDefinition & { id: CheckoutPlanId } {
  return CHECKOUT_PLAN_IDS.some((id) => id === p.id);
}

/**
 * The plans the dashboard may offer above `currentTier`.
 *
 * `CHECKOUT_PLAN_IDS` is the membership test, not "has a Stripe price": the two
 * agree today, and a plan given a price without being added to the constant
 * would otherwise be offered as an upgrade and then rejected by the checkout
 * schema that reads the same constant — a dead end in the UI.
 */
export function upgradeOptions(
  plans: readonly PlanDefinition[],
  currentTier: number,
): UpgradeDetail[] {
  return plans
    .filter(isCheckoutPlan)
    .filter((p) => p.stripePriceId !== null && p.tier > currentTier)
    .map((p) => ({ ...planDetail(p), id: p.id }));
}

// Wire = snake_case (platform casing policy). The web sends plan_id / return_url.
export const checkoutBodySchema = z.object({
  plan_id: z.enum(CHECKOUT_PLAN_IDS),
  return_url: z.string().startsWith("/").optional(),
});

export const managersBodySchema = z.object({ user_ids: z.array(z.string().min(1)) });

/** Org roles that already hold `billing:*` — see the PUT handler's refusal. */
const ROLES_WITH_BILLING_MANAGE: ReadonlySet<string> = new Set(["owner", "admin"]);

/** Wire projection — snake_case, per the platform casing policy. */
function managerDetail(m: BillingManager) {
  return { user_id: m.userId, added_by: m.addedBy, created_at: m.createdAt.toISOString() };
}

/**
 * Read and validate a JSON body. A body that is not JSON at all is reported
 * separately from one that is JSON but fails the schema — `c.req.json()` throws
 * on the first, and letting that throw reach the platform would turn a client's
 * typo into a 500. Each caller phrases its own 400.
 */
async function parseJsonBody<T>(
  c: Context<EeEnv>,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; malformed: boolean }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, malformed: true };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, malformed: false };
}

export function createBillingRoutes(appUrl: string): Hono<EeEnv> {
  const router = new Hono<EeEnv>();

  // GET /api/billing — current plan, usage percentage
  router.get("/api/billing", eeRequirePermission("billing:read"), async (c) => {
    const orgId = c.get("orgId");
    const db = getEeDb();

    const [account] = await db
      .select({
        planId: billingAccounts.planId,
        creditsUsed: billingAccounts.creditsUsed,
        creditQuota: billingAccounts.creditQuota,
        periodEnd: billingAccounts.periodEnd,
        stripeSubscriptionId: billingAccounts.stripeSubscriptionId,
        subscriptionStatus: billingAccounts.subscriptionStatus,
        cancelAtPeriodEnd: billingAccounts.cancelAtPeriodEnd,
      })
      .from(billingAccounts)
      .where(eq(billingAccounts.orgId, orgId));

    if (!account) {
      return problemJson(c, noBillingAccount());
    }

    const usagePercent =
      account.creditQuota > 0
        ? Math.min(100, Math.round((account.creditsUsed / account.creditQuota) * 100))
        : 0;

    const status = getBillingStatus(account);

    // Build upgrade options from plan definitions
    const plans = getPlans();
    const allPlans = [plans.free, plans.starter, plans.pro];
    const currentPlan = allPlans.find((p) => p.id === account.planId);
    const currentTier = currentPlan?.tier ?? 0;

    const upgrades = upgradeOptions(allPlans, currentTier);

    return c.json({
      plan: {
        id: account.planId,
        name: currentPlan?.name ?? account.planId,
      },
      plans: allPlans.map(planDetail),
      usage_percent: usagePercent,
      credits_used: account.creditsUsed,
      credit_quota: account.creditQuota,
      period_end: account.periodEnd?.toISOString() ?? null,
      status,
      upgrades,
    });
  });

  // POST /api/billing/checkout — create Stripe Checkout session (admin only, 5/min)
  router.post(
    "/api/billing/checkout",
    eeRequireAdmin(),
    eeRateLimit(5, (c) => `checkout:${c.get("orgId")}`),
    async (c) => {
      const orgId = c.get("orgId");
      const body = await parseJsonBody(c, checkoutBodySchema);
      if (!body.ok) {
        return problemJson(
          c,
          body.malformed
            ? invalidRequest("Request body must be valid JSON")
            : invalidRequest("plan_id is required", "plan_id"),
        );
      }

      try {
        const url = await createCheckoutSession(
          orgId,
          body.data.plan_id,
          appUrl,
          body.data.return_url,
        );
        return c.json({ url });
      } catch (err) {
        if (err instanceof Stripe.errors.StripeInvalidRequestError) {
          logger.error("Invalid Stripe checkout request", {
            planId: body.data.plan_id,
            orgId,
            error: err.message,
          });
          return problemJson(c, invalidRequest("Invalid plan configuration", "plan_id"));
        }
        if (err instanceof Stripe.errors.StripeRateLimitError) {
          return problemJson(c, rateLimited(1));
        }
        logger.error("Stripe checkout session creation failed", {
          orgId,
          error: err instanceof Error ? err.message : String(err),
        });
        return problemJson(c, paymentServiceUnavailable());
      }
    },
  );

  // POST /api/billing/portal — create Stripe Customer Portal session (admin only, 5/min)
  router.post(
    "/api/billing/portal",
    eeRequireAdmin(),
    eeRateLimit(5, (c) => `portal:${c.get("orgId")}`),
    async (c) => {
      const orgId = c.get("orgId");

      try {
        const url = await createPortalSession(orgId, appUrl);
        return c.json({ url });
      } catch (err) {
        logger.error("Stripe portal session creation failed", {
          orgId,
          error: err instanceof Error ? err.message : String(err),
        });
        return problemJson(c, paymentServiceUnavailable());
      }
    },
  );

  // GET /api/billing/managers — the org users granted billing:* outside RBAC
  router.get("/api/billing/managers", eeRequireAdmin(), async (c) => {
    const managers = await listBillingManagers(c.get("orgId"));
    return c.json({ managers: managers.map(managerDetail) });
  });

  // PUT /api/billing/managers — replace the whole set (the dashboard saves a list)
  router.put("/api/billing/managers", eeRequireAdmin(), async (c) => {
    const orgId = c.get("orgId");
    const body = await parseJsonBody(c, managersBodySchema);
    if (!body.ok) {
      return problemJson(
        c,
        body.malformed
          ? invalidRequest("Request body must be valid JSON")
          : invalidRequest("user_ids must be an array of user ids", "user_ids"),
      );
    }

    const wanted = [...new Set(body.data.user_ids)];

    // One platform call answers both refusals below: EE has no access to the
    // platform's membership table, and an id that is not a member of this org
    // simply does not come back.
    const members = wanted.length === 0 ? [] : await getOrgQueries().getOrgMembers(orgId, wanted);
    const byId = new Map(members.map((m) => [m.userId, m]));

    const notMembers = wanted.filter((id) => !byId.has(id));
    if (notMembers.length > 0) {
      return problemJson(
        c,
        invalidRequest(`Not a member of this organization: ${notMembers.join(", ")}`, "user_ids"),
      );
    }

    // Owners and admins already hold `billing:read` + `billing:manage` from
    // their org role, so listing them here grants nothing. Accepting the write
    // would be accepting a row that means nothing — and worse, a list the org
    // reads as "these people can act on billing" while the people who actually
    // can are the ones NOT on it. Refuse and say so.
    const redundant = wanted.filter((id) => ROLES_WITH_BILLING_MANAGE.has(byId.get(id)!.role));
    if (redundant.length > 0) {
      return problemJson(
        c,
        invalidRequest(
          `Owners and admins already manage billing through their organization role: ${redundant.join(", ")}`,
          "user_ids",
        ),
      );
    }

    const managers = await replaceBillingManagers(orgId, wanted, c.get("userId"));
    return c.json({ managers: managers.map(managerDetail) });
  });

  // GET /api/billing/contact — where invoices and payment alerts go
  router.get("/api/billing/contact", eeRequireAdmin(), async (c) => {
    const contact = await getBillingContact(c.get("orgId"));
    if (!contact) return problemJson(c, noBillingAccount());
    return c.json({ billing_email: contact.billingEmail, billing_cc: contact.billingCc });
  });

  // PATCH /api/billing/contact — set the contact (and the Stripe customer email)
  router.patch("/api/billing/contact", eeRequireAdmin(), async (c) => {
    const body = await parseJsonBody(c, billingContactPatchSchema);
    if (!body.ok) {
      return problemJson(
        c,
        body.malformed
          ? invalidRequest("Request body must be valid JSON")
          : invalidRequest(
              `billing_email must be an email address and billing_cc at most ${MAX_BILLING_CC} of them`,
            ),
      );
    }

    const contact = await updateBillingContact(c.get("orgId"), body.data);
    if (!contact) return problemJson(c, noBillingAccount());
    return c.json({ billing_email: contact.billingEmail, billing_cc: contact.billingCc });
  });

  // POST /api/billing/webhooks — Stripe webhook receiver (no auth, verified by signature)
  router.post("/api/billing/webhooks", async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header("stripe-signature");
    if (!signature) return c.text("Missing stripe-signature header", 400);

    try {
      await handleWebhook(rawBody, signature);
      return c.json({ received: true });
    } catch (err) {
      if (err instanceof Stripe.errors.StripeSignatureVerificationError) {
        logger.warn("Stripe webhook signature verification failed");
        return c.text("Invalid signature", 400);
      }
      logger.error("Webhook processing error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.text("Webhook processing error", 500);
    }
  });

  return router;
}
