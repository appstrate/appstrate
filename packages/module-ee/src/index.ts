// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import type { AppstrateModule, BeforeUsageParams, UsageRejection } from "@appstrate/core/module";
import { initEeDb, migrateEeDb, closeEeDb } from "./db.ts";
import { initEeRedis, getEeRedis } from "./redis.ts";
import { getEeEnv } from "./env.ts";
import { setPlatformServices } from "./platform.ts";
import { setOrgQueries, type EeInitContext } from "./platform-org-queries.ts";
import { checkQuota, QuotaExceededError } from "./billing/quota-check.ts";
import { quoteUsage, assertExecutionFacts } from "./billing/usage-quote.ts";
import { logger } from "./logger.ts";
import { DEFAULT_QUOTE_RATES } from "./config.ts";
import {
  startBillingSweeper,
  stopBillingSweeper,
  drainBillingSweeper,
} from "./billing/billing-sweeper.ts";
import { ensureCursorSeeded } from "./billing/usage-recorder.ts";
import { getEeDb } from "./db.ts";
import { onOrgCreate, onOrgDelete } from "./onboarding/post-signup.ts";
import { checkoutBodySchema, createBillingRoutes, managersBodySchema } from "./routes/billing.ts";
import { openApiPaths, openApiTags, openApiComponentSchemas } from "./openapi.ts";
import { renderEeVerificationEmail } from "./emails/templates/verification.ts";
import { renderEeInvitationEmail } from "./emails/templates/invitation.ts";
import { renderEeMagicLinkEmail } from "./emails/templates/magic-link.ts";
import { renderEeResetPasswordEmail } from "./emails/templates/reset-password.ts";
import { initBillingEmail } from "./emails/send.ts";
import { resolveBillingRecipients } from "./emails/recipients.ts";
import { BILLING_MANAGER_PERMISSIONS, isBillingManager } from "./billing/managers.ts";
import { billingContactPatchSchema } from "./billing/contact.ts";
import { z } from "zod";

// Register `billing` as a module-owned RBAC resource. The declaration
// merging on `ModuleResources` feeds the typed `Resource` union consumed
// by core's `requireModulePermission` guard; the runtime grant matrix is
// declared via `permissionsContribution` on the module export below. Both
// surfaces MUST stay in sync (compile-time vocabulary === runtime grants).
//
// Zero-footprint: when EE is absent from `MODULES`, `billing` disappears
// from `CoreResources ∪ ModuleResources`, role sets, and the API-key
// allowlist. OSS deployments no longer carry dead `billing:*` scope strings.
declare module "@appstrate/core/permissions" {
  interface ModuleResources {
    billing: "read" | "manage";
  }
}

// Email template overrides — branded Appstrate Cloud versions
const emailOverrides = {
  verification: renderEeVerificationEmail,
  invitation: renderEeInvitationEmail,
  "magic-link": renderEeMagicLinkEmail,
  "reset-password": renderEeResetPasswordEmail,
};

let _appUrl: string | null = null;

function getAppUrl(): string {
  if (!_appUrl) throw new Error("EE not initialized. Call init() first.");
  return _appUrl;
}

// ---------------------------------------------------------------------------
// AppstrateModule — native contract implementation
// ---------------------------------------------------------------------------

const eeModule: AppstrateModule = {
  manifest: {
    id: "ee",
    name: "Appstrate EE",
    version: "0.1.0",
  },

  // `EeInitContext` narrows the platform's `ModuleInitContext` with the two
  // org queries this module needs (`platform-org-queries.ts`). `init` is a
  // method on the contract, so the narrowing is accepted — and it puts EE's
  // requirement in the signature instead of in a comment.
  async init(ctx: EeInitContext) {
    // Fail-fast: validate all EE env vars (incl. EE_DATABASE_URL) first.
    let eeEnv;
    try {
      eeEnv = getEeEnv();
    } catch {
      throw new Error("EE env vars not configured (Stripe keys / EE_DATABASE_URL missing)");
    }

    _appUrl = ctx.appUrl;
    // Capture the platform handle — EE's ONLY platform reads are the
    // append-only `llm_usage` ledger cursor (`services.usage.list` /
    // `services.usage.settledFrontier`), never a cross-DB join.
    setPlatformServices(ctx.services);
    // The org queries answer what EE's own database cannot: who owns this
    // org, and whether a user id is a member of it. Read directly — the
    // `@appstrate/core` floor in `package.json` is what guarantees they exist.
    setOrgQueries(ctx);

    // EE owns its database: connect + self-migrate against EE_DATABASE_URL.
    // `ModuleInitContext` exposes no platform database at all — a separate-tenant
    // module reads platform data through `ctx.services`, never through a
    // connection of its own.
    initEeDb(eeEnv.EE_DATABASE_URL);
    await migrateEeDb(eeEnv.EE_DATABASE_URL);

    if (ctx.redisUrl) {
      initEeRedis(ctx.redisUrl);
    }

    // Initialize billing email transport. `getOrgName` is REQUIRED on
    // `ModuleInitContext` at this module's declared `@appstrate/core` floor, so
    // it is read directly — no fallback.
    initBillingEmail({
      sendMail: await ctx.getSendMail(),
      getRecipients: resolveBillingRecipients,
      getOrgName: ctx.getOrgName,
    });

    // Seed the billing cursor synchronously, BEFORE the sweeper starts and
    // before the platform server takes traffic. On the first boot after
    // migration 0001 creates an empty `ee_billing_cursor`, this initializes
    // the watermark at the platform's settled frontier NOW, so any billable
    // usage recorded between boot and the first sweep tick (~5 min) is billed by
    // that first tick instead of falling below a watermark only set at the tick.
    // Idempotent + race-safe (ON CONFLICT DO NOTHING); a warm boot is a no-op.
    await ensureCursorSeeded(ctx.services, getEeDb());

    // Billing sweeper — the EE metering consumer. Sweeps the platform's
    // append-only `llm_usage` ledger by serial-`id` cursor, claims the
    // platform-provided rows into `ee_billed_llm_usage`, and debits credits.
    // A failed pass advances nothing and the next tick retries. Its tick also
    // starts (without awaiting) the throttled storage-entitlement reconcile.
    // Disabled when `EE_RECONCILIATION_INTERVAL_SECONDS=0`.
    startBillingSweeper();
  },

  publicPaths: ["/api/billing/webhooks"],

  createRouter() {
    return createBillingRoutes(getAppUrl());
  },

  openApiPaths,
  openApiTags,
  openApiComponentSchemas,

  // The request bodies the routes actually parse, so `verify:openapi` §4 can
  // hold each one against the shape `openapi.ts` documents. `POST
  // /api/billing/webhooks` is absent because it parses no JSON at all — the
  // Stripe signature covers the raw text (`EXEMPT_REQUEST_BODIES`).
  openApiSchemas() {
    return [
      {
        method: "POST",
        path: "/api/billing/checkout",
        jsonSchema: z.toJSONSchema(checkoutBodySchema) as Record<string, unknown>,
        description: "Create a Stripe Checkout session",
      },
      {
        method: "PUT",
        path: "/api/billing/managers",
        jsonSchema: z.toJSONSchema(managersBodySchema) as Record<string, unknown>,
        description: "Replace the billing-manager set",
      },
      {
        method: "PATCH",
        path: "/api/billing/contact",
        jsonSchema: z.toJSONSchema(billingContactPatchSchema) as Record<string, unknown>,
        description: "Update the billing contact",
      },
    ];
  },

  // `custom_roles` gates the platform's own `POST/PATCH/DELETE /api/roles`
  // (RBAC spec §9): the space-role data model, the presets and the read routes
  // are OSS, but DEFINING a custom bundle is the EE surface, and EE is the
  // module that licenses it today.
  features: { billing: true, custom_roles: true },

  // RBAC contribution: billing is org-level (a plan is bought by the
  // organization, not by one of its spaces) and session-only — neither
  // `apiKeyGrantable` nor `endUserGrantable`, which is also what makes both
  // strings legal in `mayGrant` below. `manage` is admin-tier (Stripe checkout
  // / portal + subscription state); `read` reaches every member so the
  // dashboard can surface plan + usage to non-admins. A `guest` gets neither:
  // someone invited into one space has no business reading what the
  // organization spends.
  permissionsContribution: () => [
    {
      resource: "billing",
      actions: ["read"],
      level: "org",
      grantTo: ["owner", "admin", "member"],
    },
    {
      resource: "billing",
      actions: ["manage"],
      level: "org",
      grantTo: ["owner", "admin"],
    },
  ],

  // Billing managers: the same two strings, handed to named principals instead
  // of to a role (RBAC spec §10). This is what lets an org delegate billing
  // without promoting someone to admin — and what keeps `billing` out of core's
  // Apache-2.0 `org_role` enum, where a `billing_manager` role would have to
  // live. The resolver is one primary-key lookup per principal per cache miss;
  // `billing/managers.ts` owns the invalidation its own writes require.
  principalPermissions: {
    mayGrant: BILLING_MANAGER_PERMISSIONS,
    resolve: async ({ orgId, userId }) =>
      (await isBillingManager(orgId, userId)) ? BILLING_MANAGER_PERMISSIONS : [],
  },

  emailOverrides,

  hooks: {
    // Unified admission gate (first-match-wins). Billing is NOT done here — the
    // cursor sweeper (billing-sweeper.ts) is the sole biller. This is a
    // read-only soft-cap check.
    //
    // The platform dispatches this hook on EVERY metered usage attempt and
    // never pre-classifies an operation as free; it reports neutral execution
    // facts and this module quotes them. Admission therefore gates on an
    // estimated AMOUNT, not on "is the model platform-provided?" — the old rule
    // hard-coded "BYOK ⇒ free", which stops being true the moment platform
    // compute is billed.
    beforeUsage: async (params: BeforeUsageParams): Promise<UsageRejection | null> => {
      // VERSION-SKEW GUARD — must precede the short-circuit.
      //
      // The execution facts are typed as required, but they are filled at
      // runtime by a SEPARATELY DEPLOYED platform, and every layer below fails
      // OPEN without them: `undefined !== "system" && undefined !== "platform"`
      // satisfies the short-circuit, and even past it the quote would score both
      // components 0 and the balance check would admit. So the shape is checked
      // rather than trusted — and an unrecognized one is REFUSED, never adapted
      // to (`assertExecutionFacts` throws an `ApiError`; `src/http-errors.ts`
      // argues which one and what each admission seam does with it).
      //
      // "Below the short-circuit" is not an available position, and that is
      // worth stating because the ordering reads like an over-reach: it looks as
      // though a fully self-funded remote BYOK run — one this module lets
      // through without touching the billing DB — is refused on facts it does
      // not need in order to be billed. It is not. The short-circuit is ITSELF a
      // read of the two facts under suspicion, so a skewed admission satisfies
      // it and returns `null` before any assertion placed after it could run.
      // Moving the guard down would not narrow it to platform-funded
      // operations — it would disable it for all of them. Nor can the refusal
      // fire on a genuinely self-funded operation: recognizing one AS
      // self-funded takes facts this module knows, and facts it knows pass.
      //
      // Deliberately OUTSIDE the try below: that catch reports an unexpected
      // failure as a 500 "temporarily unavailable", which is true of a DB blip
      // and false of a version mismatch. A permanent misconfiguration reported
      // as transient is the silent degrade this guard exists to remove.
      assertExecutionFacts(params);

      // Self-funded short-circuit: the org supplies both the credential and the
      // host (a remote BYOK run), so the platform funds nothing and there is
      // nothing to gate. Returning here BEFORE the quote keeps the billing DB
      // out of this path entirely — which is a correctness property, not just a
      // load one: such an org may legitimately have no billing account at all.
      if (params.credentialSource !== "system" && params.executionPlane !== "platform") {
        return null;
      }

      const quote = quoteUsage(params, DEFAULT_QUOTE_RATES);
      try {
        await checkQuota(params.orgId, quote);
        return null;
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          // Distinct wire codes for the two INDEPENDENT gates, read off the
          // already-typed `reason` (never re-derived from the message text):
          // a blocked subscription is an entitlement failure the org resolves by
          // fixing its subscription, while an exhausted balance is an arithmetic
          // failure it resolves by topping up. Flattening both into one code
          // would make that independence unobservable to callers — and
          // independence a client cannot distinguish is not independence.
          // `no_account` rides with the balance code: it is reached only for a
          // positive quote, i.e. "you owe and have nothing to draw on".
          // Same split as RFC 4006/8506 credit-control, which separates
          // 4010 END_USER_SERVICE_DENIED (entitlement) from
          // 4012 CREDIT_LIMIT_REACHED (arithmetic). HTTP 402 for all three —
          // only the code narrows the cause.
          const code = err.reason === "status" ? "subscription_blocked" : "quota_exceeded";
          return { code, message: err.message, status: 402 };
        }
        // Fail CLOSED: an unexpected error here (DB down, bad state) must not
        // silently admit unbounded usage the sweeper would then bill.
        //
        // The real cause goes to the log, never into `message`: that field
        // becomes the RFC 9457 `detail` handed to API consumers, and a thrown
        // error here names our tables and our schema.
        logger.error("beforeUsage failed — refusing usage", {
          orgId: params.orgId,
          context: params.context,
          err: err instanceof Error ? err.message : String(err),
        });
        return {
          code: "unexpected",
          message: "Billing is temporarily unavailable.",
          status: 500,
        };
      }
    },
  },

  events: {
    onOrgCreate,
    onOrgDelete,
  },

  async shutdown() {
    // Stop scheduling new work, then let the in-flight pass finish before the
    // DB pool closes so it is not torn out mid-transaction. The timer is
    // cleared FIRST so nothing new starts while we drain.
    stopBillingSweeper();
    await drainBillingSweeper();
    const redis = getEeRedis();
    if (redis) {
      await redis.quit();
    }
    await closeEeDb();
  },
};

export default eeModule;

// ---------------------------------------------------------------------------
// Named exports — direct access for tests + custom integrations
// ---------------------------------------------------------------------------

export { QuotaExceededError };
export { emailOverrides };
