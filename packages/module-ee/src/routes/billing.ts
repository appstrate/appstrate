// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { Hono, type Context } from "hono";
import Stripe from "stripe";
import { z } from "zod";
import { getEeDb } from "../db.ts";
import { billingAccounts } from "../../drizzle/schema.ts";
import { eq } from "drizzle-orm";
import { createCheckoutSession } from "../stripe/checkout.ts";
import { changeSubscriptionPlan } from "../stripe/plan.ts";
import { createPortalSession } from "../stripe/portal.ts";
import { handleWebhook } from "../stripe/webhooks.ts";
import {
  CHECKOUT_PLAN_IDS,
  getPlans,
  LIVE_SUBSCRIPTION_STATUSES,
  planAction,
  WARNING_STATUSES,
  type PlanDefinition,
} from "../config.ts";
import { logger } from "../logger.ts";
import { eeRateLimit } from "../middleware.ts";
import {
  listBillingManagers,
  replaceBillingManagers,
  type BillingManager,
} from "../billing/managers.ts";
import {
  billingContactPatchSchema,
  getBillingContact,
  updateBillingContact,
} from "../billing/contact.ts";
import { getOrgQueries } from "../platform-org-queries.ts";
import {
  problemJson,
  noBillingAccount,
  rateLimited,
  paymentServiceUnavailable,
} from "../http-errors.ts";
import { ApiError, invalidRequest } from "@appstrate/core/api-errors";
import { readJsonBody } from "@appstrate/core/request-body";
import {
  ORG_ROLES_WITH_FULL_ACCESS,
  requireModulePermission,
  type OrgRole,
} from "@appstrate/core/permissions";

// Minimal env type — set by the platform's auth + RBAC middleware. `user` is
// the caller as `apps/api/src/lib/auth-pipeline.ts` writes it (the same shape
// the platform's own `AppEnv` declares): billing-manager grants are attributed
// to whoever made them, and the platform's `principalPermissions` surface is
// session-only, so a request reaching a `billing:manage` route always has one.
type EeEnv = {
  Variables: {
    orgId: string;
    orgRole: OrgRole;
    user: { id: string; email: string; name: string };
    permissions: ReadonlySet<string>;
  };
};

const KNOWN_STATUSES = new Set([
  ...WARNING_STATUSES,
  "active",
  "trialing",
  "incomplete",
  "canceled",
]);

/**
 * The status the dashboard reads, projected from the account row.
 *
 * `canceling` projects `cancel_at_period_end`, gated on the underlying status
 * being one a plan change accepts (`LIVE_SUBSCRIPTION_STATUSES`): Stripe keeps
 * the cancel flag on an `unpaid` or `paused` subscription, and reporting
 * `canceling` there would send the dashboard to `POST /api/billing/plan`, which
 * answers 409. Those accounts report their real status, which is what routes
 * them to the Customer Portal where the payment needs fixing.
 */
function getBillingStatus(account: {
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  cancelAtPeriodEnd: boolean;
}): string {
  if (!account.stripeSubscriptionId) return "none";
  if (
    account.cancelAtPeriodEnd &&
    account.subscriptionStatus &&
    LIVE_SUBSCRIPTION_STATUSES.has(account.subscriptionStatus)
  )
    return "canceling";
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
export const checkoutBodySchema = z
  .object({
    plan_id: z.enum(CHECKOUT_PLAN_IDS),
    return_url: z.string().startsWith("/").optional(),
  })
  .strict();

/** `POST /api/billing/plan` — the same plan ids, no redirect to come back from. */
export const planBodySchema = z.object({ plan_id: z.enum(CHECKOUT_PLAN_IDS) }).strict();

export const managersBodySchema = z.object({ user_ids: z.array(z.string().min(1)) }).strict();

/** Org roles that already hold `billing:*` — see the PUT handler's refusal. */
const ROLES_WITH_BILLING_MANAGE: ReadonlySet<string> = new Set(ORG_ROLES_WITH_FULL_ACCESS);

/** Wire projection — snake_case, per the platform casing policy. */
function managerDetail(m: BillingManager) {
  return { user_id: m.userId, added_by: m.addedBy, created_at: m.createdAt.toISOString() };
}

/**
 * The wire projection of one org's billing account — plan, usage, status and the
 * upgrades it may take.
 *
 * Shared by `GET /api/billing` and the answer to a plan change, so the dashboard
 * refreshes from the same shape it renders. `null` when the org has no billing
 * account.
 *
 * `plan_action` is the server's answer to "where does a plan selection go" —
 * the same `planAction` predicate `createCheckoutSession` and
 * `changeSubscriptionPlan` refuse on, so a dashboard that follows it never
 * calls an endpoint this API is going to reject.
 */
async function billingSnapshot(orgId: string) {
  const [account] = await getEeDb()
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

  if (!account) return null;

  const usagePercent =
    account.creditQuota > 0
      ? Math.min(100, Math.round((account.creditsUsed / account.creditQuota) * 100))
      : 0;

  const plans = getPlans();
  const allPlans = [plans.free, plans.starter, plans.pro];
  const currentPlan = allPlans.find((p) => p.id === account.planId);

  return {
    plan: {
      id: account.planId,
      name: currentPlan?.name ?? account.planId,
    },
    plans: allPlans.map(planDetail),
    usage_percent: usagePercent,
    credits_used: account.creditsUsed,
    credit_quota: account.creditQuota,
    period_end: account.periodEnd?.toISOString() ?? null,
    status: getBillingStatus(account),
    plan_action: planAction(account),
    upgrades: upgradeOptions(allPlans, currentPlan?.tier ?? 0),
  };
}

/**
 * Render the failure of a Stripe-facing billing call.
 *
 * `ApiError` first: the refusals this module raises itself (a second concurrent
 * subscription, a plan change with nothing to change) are decisions, and burying
 * them under a generic 503 would tell the caller to retry something that can
 * never succeed.
 */
function stripeCallFailure(
  c: Context<EeEnv>,
  err: unknown,
  context: Record<string, unknown>,
): Response {
  if (err instanceof ApiError) return problemJson(c, err);
  if (err instanceof Stripe.errors.StripeInvalidRequestError) {
    logger.error("Invalid Stripe request", { ...context, error: err.message });
    return problemJson(c, invalidRequest("Invalid plan configuration", "plan_id"));
  }
  if (err instanceof Stripe.errors.StripeRateLimitError) {
    return problemJson(c, rateLimited(1));
  }
  logger.error("Stripe call failed", {
    ...context,
    error: err instanceof Error ? err.message : String(err),
  });
  return problemJson(c, paymentServiceUnavailable());
}

export function createBillingRoutes(appUrl: string): Hono<EeEnv> {
  const router = new Hono<EeEnv>();

  // The shared permission guards and body reader signal a refusal by THROWING an
  // `ApiError`; the module's own Stripe-facing failures return `problemJson`
  // directly. Hono honours a mounted sub-app's error handler, so this one renders
  // both halves as the same RFC 9457 body whether the router is mounted in the
  // platform app or stood up alone (this module's tests). Anything else is
  // rethrown, so the platform's handler still owns the 500 path.
  router.onError((err, c) => {
    if (err instanceof ApiError) return problemJson(c, err);
    throw err;
  });

  // GET /api/billing — current plan, usage percentage
  router.get("/api/billing", requireModulePermission("billing", "read"), async (c) => {
    const snapshot = await billingSnapshot(c.get("orgId"));
    if (!snapshot) return problemJson(c, noBillingAccount());
    return c.json(snapshot);
  });

  // POST /api/billing/checkout — create Stripe Checkout session (admin only, 5/min)
  router.post(
    "/api/billing/checkout",
    requireModulePermission("billing", "manage"),
    eeRateLimit(5, (c) => `checkout:${c.get("orgId")}`),
    async (c) => {
      const orgId = c.get("orgId");
      const body = await readJsonBody(c, checkoutBodySchema);

      try {
        const url = await createCheckoutSession(orgId, body.plan_id, appUrl, body.return_url);
        return c.json({ url });
      } catch (err) {
        return stripeCallFailure(c, err, { route: "checkout", orgId, planId: body.plan_id });
      }
    },
  );

  // POST /api/billing/plan — move an EXISTING subscription onto another plan
  // (admin only, 5/min). Checkout is for an org that has no subscription; this
  // is the only door for one that does, and the server enforces the split.
  router.post(
    "/api/billing/plan",
    requireModulePermission("billing", "manage"),
    eeRateLimit(5, (c) => `plan:${c.get("orgId")}`),
    async (c) => {
      const orgId = c.get("orgId");
      const body = await readJsonBody(c, planBodySchema);

      try {
        await changeSubscriptionPlan(orgId, body.plan_id);
      } catch (err) {
        return stripeCallFailure(c, err, { route: "plan", orgId, planId: body.plan_id });
      }

      // The account itself is written by the `customer.subscription.updated`
      // webhook Stripe sends back, so this snapshot may still name the previous
      // plan. It is returned anyway because everything else in it — status,
      // period end, credits — is current, and the dashboard refetches.
      const snapshot = await billingSnapshot(orgId);
      if (!snapshot) return problemJson(c, noBillingAccount());
      return c.json(snapshot);
    },
  );

  // POST /api/billing/portal — create Stripe Customer Portal session (admin only, 5/min)
  router.post(
    "/api/billing/portal",
    requireModulePermission("billing", "manage"),
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
  router.get("/api/billing/managers", requireModulePermission("billing", "manage"), async (c) => {
    const managers = await listBillingManagers(c.get("orgId"));
    return c.json({ managers: managers.map(managerDetail) });
  });

  // PUT /api/billing/managers — replace the whole set (the dashboard saves a list)
  router.put("/api/billing/managers", requireModulePermission("billing", "manage"), async (c) => {
    const orgId = c.get("orgId");
    const body = await readJsonBody(c, managersBodySchema);

    const wanted = [...new Set(body.user_ids)];

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

    const managers = await replaceBillingManagers(orgId, wanted, c.get("user").id);
    return c.json({ managers: managers.map(managerDetail) });
  });

  // GET /api/billing/contact — where invoices and payment alerts go
  router.get("/api/billing/contact", requireModulePermission("billing", "manage"), async (c) => {
    const contact = await getBillingContact(c.get("orgId"));
    if (!contact) return problemJson(c, noBillingAccount());
    return c.json({ billing_email: contact.billingEmail, billing_cc: contact.billingCc });
  });

  // PATCH /api/billing/contact — set the contact (and the Stripe customer email)
  router.patch("/api/billing/contact", requireModulePermission("billing", "manage"), async (c) => {
    const body = await readJsonBody(c, billingContactPatchSchema);

    const contact = await updateBillingContact(c.get("orgId"), body);
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
