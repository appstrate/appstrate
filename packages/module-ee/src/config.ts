// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { getEeEnv } from "./env.ts";
import type { QuoteRates } from "./billing/usage-quote.ts";

export interface PlanDefinition {
  id: string;
  name: string;
  tier: number;
  creditQuota: number; // credits per billing cycle (e.g. 5000 = $5.00 worth)
  fileStorageBytes: number; // durable-file storage entitlement (bytes)
  monthlyPrice: number; // display dollars (e.g. 29 = $29/mo)
  stripePriceId: string | null;
}

/** Byte multiplier for plan storage entitlements. */
export const GIB = 1024 * 1024 * 1024;

/**
 * The plans checkout accepts — every plan with a Stripe price, which is the
 * catalog minus `free`. Declared here rather than at either consumer because
 * the fact it encodes is a property of the catalog below (`free` is the one
 * `PlanDefinition` whose `stripePriceId` is `null`), and both the request
 * schema (`routes/billing.ts`) and the wire contract (`openapi.ts`) have to
 * mean the same set.
 */
export const CHECKOUT_PLAN_IDS = ["starter", "pro"] as const;

export interface Plans {
  free: PlanDefinition;
  starter: PlanDefinition;
  pro: PlanDefinition;
  [key: string]: PlanDefinition | undefined;
}

/**
 * Build plan definitions from env config. Not cached independently
 * since getEeEnv() is already a lazy singleton.
 */
export function getPlans(): Plans {
  const env = getEeEnv();
  return {
    free: {
      id: "free",
      name: "Free",
      tier: 0,
      creditQuota: 5000,
      fileStorageBytes: 1 * GIB,
      monthlyPrice: 0,
      stripePriceId: null,
    },
    starter: {
      id: "starter",
      name: "Starter",
      tier: 1,
      creditQuota: 20000,
      fileStorageBytes: 20 * GIB,
      monthlyPrice: 29,
      stripePriceId: env.STRIPE_PRICE_ID_STARTER,
    },
    pro: {
      id: "pro",
      name: "Pro",
      tier: 2,
      creditQuota: 80000,
      fileStorageBytes: 100 * GIB,
      monthlyPrice: 99,
      stripePriceId: env.STRIPE_PRICE_ID_PRO,
    },
  };
}

/**
 * Estimated MODEL cost per projected in-flight run (in credits).
 * Platform includes the run currently being admitted in `runningCount`, so the
 * first run is estimated as one run rather than zero.
 * Conservative default: 200 credits ($0.20) — covers a typical AI agent run.
 *
 * MODEL-only: this rate has always covered inference paid with a
 * platform-supplied credential, and nothing else. The name now says so, because
 * compute is quoted as a separate component (see below).
 */
export const ESTIMATED_MODEL_CREDITS_PER_RUN = 200;

/**
 * Estimated MODEL cost per chat turn (in credits).
 * A chat turn is short-lived (single request/response), so — unlike a run —
 * there is no concurrency term: the estimate is a flat per-turn figure used to
 * pessimistically gate admission before the turn's usage lands in the ledger.
 * Conservative default: 20 credits ($0.02).
 */
export const ESTIMATED_MODEL_CREDITS_PER_CHAT_TURN = 20;

/**
 * Estimated COMPUTE cost per second of a run's effective (post-ceiling) timeout.
 *
 * Phase 1 ships 0: platform compute is NOT charged yet. The quoting arithmetic,
 * the facts the platform reports, and the admission path are all already in
 * place — flipping this constant to a non-zero value is the ONLY change
 * required to start gating on compute. No new hook, no new core field, no
 * change to where admission fires.
 */
export const COMPUTE_CREDITS_PER_RUN_SECOND = 0;

/**
 * Estimated COMPUTE cost per chat turn (in credits).
 *
 * Phase 1 ships 0, same as the per-run-second rate: flipping it to a non-zero
 * value is the ONLY change required to start gating chat on compute.
 */
export const COMPUTE_CREDITS_PER_CHAT_TURN = 0;

/**
 * Production rates handed to `quoteUsage`. Assembled here — once — so the hook
 * never builds the object inline and every seam quotes against the same figures.
 */
export const DEFAULT_QUOTE_RATES: QuoteRates = {
  modelCreditsPerRun: ESTIMATED_MODEL_CREDITS_PER_RUN,
  modelCreditsPerChatTurn: ESTIMATED_MODEL_CREDITS_PER_CHAT_TURN,
  computeCreditsPerRunSecond: COMPUTE_CREDITS_PER_RUN_SECOND,
  computeCreditsPerChatTurn: COMPUTE_CREDITS_PER_CHAT_TURN,
};

/** Subscription statuses that suspend all platform-funded usage, even when its quote is zero. */
export const HARD_BLOCKED_STATUSES = new Set(["unpaid", "paused"]);

/** Ended paid entitlements: free usage remains available, positive quotes do not. */
export const ENDED_SUBSCRIPTION_STATUSES = new Set(["canceled", "incomplete_expired"]);

/** Subscription statuses that trigger a warning banner in the UI (may overlap with hard blocks) */
export const WARNING_STATUSES = new Set(["past_due", "unpaid", "paused"]);
