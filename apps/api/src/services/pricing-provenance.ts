// SPDX-License-Identifier: Apache-2.0

/**
 * Pricing provenance — the single policy home for `llm_usage.pricing_status`.
 *
 * `computeTokenCost` is permissive by design (`if (!cost) return 0`, `?? 0` on
 * both cache rates), which is correct arithmetic but makes "no rates exist for
 * this model" indistinguishable from "this consumption was genuinely free".
 * Every producer of a ledger row therefore runs its usage + rates through
 * {@link resolvePricingStatus}, which does two things at once:
 *
 *   1. classifies, by DELEGATING to `classifyTokenPricing`
 *      (`@appstrate/afps-runtime/runner`, next to the cost formula itself) —
 *      the rules are never re-derived here;
 *   2. logs the gap, so a model the platform cannot price is visible to
 *      operators the first time it is spent on, not only via a later SQL query.
 *
 * One helper rather than three call-site copies: the three producers (proxy
 * meter, subscription chat, agent runner) must agree on both halves, and a
 * warn-line that only some paths emit is worse than none — it reads as "the
 * other paths are fine".
 */

import type { TokenUsage } from "@appstrate/afps-shared/token-usage";
import {
  classifyTokenPricing,
  type TokenCost,
  type TokenPricingStatus,
} from "@appstrate/afps-runtime/runner";
import { logger } from "../lib/logger.ts";

/**
 * Upper bound on remembered `(org, model, status)` keys. Exceeding it clears
 * the whole set rather than evicting one entry: the set is a log-noise damper,
 * not a cache, so the cheapest possible bound is the right one — the worst case
 * is one extra warn line per key after a reset.
 */
const WARNED_KEYS_CAP = 500;

/**
 * Keys already warned about IN THIS PROCESS. The de-dup is explicitly
 * BEST-EFFORT and per-process, not a guarantee: a multi-instance deployment
 * emits the line once per replica, a rolling deploy re-arms it, and a cap reset
 * re-arms it. That is the intended trade — the line exists to be noticed, and
 * suppressing it globally would need shared state (Redis) for a diagnostic that
 * is already recoverable from the ledger.
 */
const warnedKeys = new Set<string>();

interface PricingProvenanceInput {
  /** Tenant the spend is attributed to — half of the log de-dup key. */
  orgId: string;
  /**
   * Model the row is about — the preset id on the proxy/chat paths, the run's
   * model label on the runner path. Only used for the log line and the de-dup
   * key; `null` degrades to a single "unknown" bucket per org.
   */
  model: string | null;
  /** Token counts the row is being written with. */
  usage: TokenUsage;
  /** Rates used to price them — `null`/`undefined` is the `unpriced` case. */
  cost: TokenCost | null | undefined;
  /** Extra fields merged into the log line (runId, chatSessionId, source, …). */
  context?: Record<string, unknown>;
}

/**
 * Classify one ledger row's pricing provenance, warning once per
 * `(orgId, model, status)` per process on anything but `priced`.
 *
 * Mirrors the shape of the existing accountability precedent in
 * `llm-proxy/metering.ts` (`llm-proxy: successful response contained no
 * parseable usage`): one structured line, named after the accounting fact it
 * reports, carrying the attribution needed to act on it. `warn` rather than
 * `error` because — unlike an unparseable usage payload — nothing is lost: the
 * row IS recorded, correctly, and now says so.
 */
export function resolvePricingStatus(input: PricingProvenanceInput): TokenPricingStatus {
  const status = classifyTokenPricing(input.usage, input.cost);
  if (status === "priced") return status;

  // `JSON.stringify` rather than concatenation: unambiguous without depending on a
  // separator byte being absent from the components, and it keeps this file plain text.
  const key = JSON.stringify([input.orgId, input.model ?? "", status]);
  if (warnedKeys.has(key)) return status;
  if (warnedKeys.size >= WARNED_KEYS_CAP) warnedKeys.clear();
  warnedKeys.add(key);

  logger.warn("llm_usage: token usage recorded without complete model pricing", {
    pricingStatus: status,
    orgId: input.orgId,
    model: input.model,
    ...input.context,
  });
  return status;
}
