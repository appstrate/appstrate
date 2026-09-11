// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import type {
  AppstrateModule,
  BeforeUsageParams,
  ModuleInitContext,
  UsageRejection,
} from "@appstrate/core/module";
import { initEeDb, migrateEeDb, closeEeDb, getEeDb } from "./db.ts";
import { initEeRedis, getEeRedis } from "./redis.ts";
import { describeEnvIssues, getEeEnv } from "./env.ts";
import { getAppUrl, setAppUrl, setPlatformServices } from "./platform.ts";
import { setOrgQueries } from "./platform-org-queries.ts";
import { checkQuota, QuotaExceededError } from "./billing/quota-check.ts";
import { quoteUsage } from "./billing/usage-quote.ts";
import { logger } from "./logger.ts";
import { DEFAULT_QUOTE_RATES } from "./config.ts";
import {
  assertCursorResumable,
  startBillingSweeper,
  stopBillingSweeper,
  drainBillingSweeper,
} from "./billing/billing-sweeper.ts";
import { ensureCursorSeeded } from "./billing/usage-recorder.ts";
import { onOrgCreate, onOrgDelete } from "./onboarding/post-signup.ts";
import {
  checkoutBodySchema,
  createBillingRoutes,
  managersBodySchema,
  planBodySchema,
} from "./routes/billing.ts";
import { openApiPaths, openApiTags, openApiComponentSchemas } from "./openapi.ts";
import { renderEeVerificationEmail } from "./emails/templates/verification.ts";
import { renderEeInvitationEmail } from "./emails/templates/invitation.ts";
import { renderEeMagicLinkEmail } from "./emails/templates/magic-link.ts";
import { renderEeResetPasswordEmail } from "./emails/templates/reset-password.ts";
import { initBillingEmail } from "./emails/send.ts";
import { resolveBillingRecipients } from "./emails/recipients.ts";
import { BILLING_MANAGER_PERMISSIONS, isBillingManager } from "./billing/managers.ts";
import { billingContactPatchSchema } from "./billing/contact.ts";
import type { EmailRenderer, EmailType } from "@appstrate/emails";
import { z } from "zod";

// Register `billing` as a module-owned RBAC resource. The declaration
// merging on `ModuleResources` feeds the typed `Resource` union consumed
// by core's `requireModulePermission` guard; the runtime grant matrix is
// declared via `permissionsContribution` on the module export below. Both
// surfaces MUST stay in sync (compile-time vocabulary === runtime grants).
//
// Zero-footprint: when EE is absent from `MODULES`, `billing` disappears
// from `CoreResources ∪ ModuleResources`, role sets, and the API-key
// allowlist. An OSS deployment carries no `billing:*` scope string at all.
declare module "@appstrate/core/permissions" {
  interface ModuleResources {
    billing: "read" | "manage";
  }
}

// Email template overrides — branded Appstrate Cloud versions. Typed against
// `@appstrate/emails`' own registry shape rather than left to inference, so a key that is
// not an `EmailType` is a `tsc` error here instead of a template the registry never
// reaches. Core's `emailOverrides` slot stays `Record<string, any>` — core cannot depend
// on a workspace-only package.
const emailOverrides: Partial<{ [K in EmailType]: EmailRenderer<K> }> = {
  verification: renderEeVerificationEmail,
  invitation: renderEeInvitationEmail,
  "magic-link": renderEeMagicLinkEmail,
  "reset-password": renderEeResetPasswordEmail,
};

// ---------------------------------------------------------------------------
// AppstrateModule — native contract implementation
// ---------------------------------------------------------------------------

const eeModule: AppstrateModule = {
  manifest: {
    id: "ee",
    name: "Appstrate EE",
    version: "0.1.0",
  },

  async init(ctx: ModuleInitContext) {
    // Fail-fast: validate all EE env vars first. The rethrow names the offending
    // variables — an operator reading a boot crash needs to know WHICH of the
    // module's env vars is wrong, not that one is.
    try {
      getEeEnv();
    } catch (cause) {
      throw new Error(`Invalid ee module environment: ${describeEnvIssues(cause)}`, { cause });
    }

    // The module's tables live in the platform database, so it reads the
    // platform's own URL. `ModuleInitContext` carries no database handle or URL
    // — a module that needs one reads it, and under tier 0 (PGlite) there is
    // none to read. The loader turns this throw into a fatal boot, which is the
    // whole of the refusal.
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        "The ee module requires PostgreSQL: set DATABASE_URL (the module stores its tables in the platform database)",
      );
    }

    setAppUrl(ctx.appUrl);
    // Capture the platform handle — EE's ONLY platform reads are the
    // append-only `llm_usage` ledger cursor (`services.usage.list` /
    // `services.usage.settledFrontier`), never a SQL join against a platform table.
    setPlatformServices(ctx.services);
    // The org queries answer what EE's own tables cannot: who owns this
    // org, and whether a user id is a member of it. Read directly — the
    // workspace `ModuleInitContext` type is what guarantees they exist, and
    // `tsc` is what checks it.
    setOrgQueries(ctx);

    // Connect + self-migrate. The `ee_*` tables land beside the platform's own
    // under a separate journal (`drizzle.ee_migrations`, see `db.ts`); platform
    // ROWS are still read through `ctx.services`, not through this pool.
    initEeDb(databaseUrl);
    await migrateEeDb(databaseUrl);

    if (ctx.redisUrl) {
      initEeRedis(ctx.redisUrl);
    }

    // Initialize billing email transport. `getOrgName` is a required member of
    // the workspace `ModuleInitContext`, so it is read directly — no fallback.
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
    const cursor = await ensureCursorSeeded(ctx.services, getEeDb());

    // Refuse to silently resume a watermark the sweeper abandoned. Re-enabling
    // the module after a window with it off leaves a gap the first tick would
    // claim in one go and debit against today's quotas — irreversibly, and
    // fleet-wide. Billing that gap or forgiving it is an operator's call, so
    // this throws (a fatal boot) and names both actions.
    await assertCursorResumable(cursor);

    // Billing sweeper — the EE metering consumer. Sweeps the platform's
    // append-only `llm_usage` ledger by serial-`id` cursor, claims the
    // platform-provided rows into `ee_billed_llm_usage`, and debits credits.
    // A failed pass advances nothing and the next tick retries. Its tick also
    // starts (without awaiting) the throttled storage-entitlement reconcile and
    // retries pending Stripe cancellations. `EE_RECONCILIATION_INTERVAL_SECONDS=0`
    // pauses the sweep only — that maintenance half keeps running.
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
        method: "POST",
        path: "/api/billing/plan",
        jsonSchema: z.toJSONSchema(planBodySchema) as Record<string, unknown>,
        description: "Change the plan of the existing subscription",
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
    // estimated AMOUNT, not on "is the model platform-provided?", which would hard-code
    // "BYOK ⇒ free" and stop being true the moment platform compute is billed.
    beforeUsage: async (params: BeforeUsageParams): Promise<UsageRejection | null> => {
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
// The platform's `usage.list` ceiling this module sizes both reconciliation
// knobs against. On the public entry so the platform can assert the two agree
// without reaching into the package.
export { LEDGER_LIST_MAX_LIMIT } from "./env.ts";
