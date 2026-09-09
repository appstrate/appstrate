// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Usage quoting — the credit estimate for one admission attempt.
 *
 * The platform decides nothing about what is free: it reports neutral execution facts
 * (`credentialSource`, `executionPlane`, `timeoutSeconds`) on every metered attempt and
 * this module turns them into the amount admission gates on. Quoting model and compute
 * separately keeps "BYOK ⇒ free" out of the topology — billing compute is a rate change.
 *
 * `quoteUsage` is deliberately PURE — no DB, no clock, no module-scope config
 * read. Rates arrive as a parameter so a test can inject a non-zero compute
 * rate without `mock.module()` (banned repo-wide) and so the production rates
 * live in exactly one place (`DEFAULT_QUOTE_RATES` in `src/config.ts`).
 */
import type { BeforeUsageParams } from "@appstrate/core/module";

/** Per-component credit estimate for a single admission attempt. */
export interface UsageQuote {
  /** Credits estimated for inference paid with a platform-supplied credential. */
  modelCredits: number;
  /** Credits estimated for platform-funded compute time. */
  computeCredits: number;
  /** `modelCredits + computeCredits` — the figure admission gates on. */
  totalCredits: number;
}

/** Credit rates the quote is derived from. Injected, never read from scope. */
export interface QuoteRates {
  /** Model estimate per projected in-flight run. */
  modelCreditsPerRun: number;
  /** Model estimate per chat turn. */
  modelCreditsPerChatTurn: number;
  /** Compute estimate per second of a run's effective timeout. Phase 1: 0. */
  computeCreditsPerRunSecond: number;
  /** Compute estimate per chat turn. Phase 1: 0. */
  computeCreditsPerChatTurn: number;
}

/**
 * Normalize one raw component into integer credits.
 *
 * Rounds UP so a sub-credit rate (e.g. 0.001 credits/second over a 30s run)
 * never silently quotes zero and lets an operation through ungated. Clamps
 * non-finite and negative inputs to 0 defensively: a rate misconfigured to
 * `NaN`/`Infinity` (or a negative count arriving from a caller bug) must not
 * poison `totalCredits` — `NaN > remaining` is false, so an unclamped NaN would
 * silently ADMIT everything, which is the opposite of the fail-closed posture
 * the rest of the admission path takes.
 */
function toCredits(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.ceil(raw);
}

/**
 * Estimate the billable components of one operation.
 *
 * - `modelCredits` — non-zero only when a platform-supplied credential funds the
 *   inference (`credentialSource === "system"`). An org spending its OWN
 *   credential (BYOK key or OAuth subscription) costs the platform no model
 *   component. `null` (a remote-origin run that resolves its model elsewhere)
 *   is likewise unquotable here — if such a run later routes inference through
 *   the system model proxy, that seam dispatches its own admission where the
 *   fact IS known.
 * - `computeCredits` — non-zero only when the work runs on platform-funded
 *   compute (`executionPlane === "platform"`). A run additionally needs a
 *   `timeoutSeconds` upper bound to derive a duration estimate from; `null`
 *   means "this seam does not own the run's compute" and contributes ZERO. It
 *   must never be read as "unknown, assume the worst": the system-proxy seam
 *   passes `null` while admitting inference for an already-running run whose
 *   compute was quoted at its own preflight, so assuming the worst would
 *   double-count it.
 */
export function quoteUsage(params: BeforeUsageParams, rates: QuoteRates): UsageQuote {
  switch (params.context) {
    case "run": {
      // Runs multiply by the projected in-flight count (which INCLUDES the run being
      // admitted) — a pessimistic concurrent-overshoot guard, since the soft cap cannot
      // reserve. KNOWN OVER-QUOTE, deferred: the system-proxy seam admits ONE
      // `/api/llm-proxy` CALL at the per-RUN rate, so a chatty agent is quoted far above
      // what it consumes. The fix needs a launch-vs-call discriminant on core's contract.
      const rawModel =
        params.credentialSource === "system" ? rates.modelCreditsPerRun * params.runningCount : 0;
      // `null` ⇒ this seam does not own the run's compute — contribute nothing.
      const rawCompute =
        params.executionPlane === "platform" && params.timeoutSeconds !== null
          ? rates.computeCreditsPerRunSecond * params.timeoutSeconds
          : 0;
      return toQuote(rawModel, rawCompute);
    }
    case "chat": {
      // A chat turn is short-lived and single-shot: no concurrency term.
      const rawModel = params.credentialSource === "system" ? rates.modelCreditsPerChatTurn : 0;
      const rawCompute = params.executionPlane === "platform" ? rates.computeCreditsPerChatTurn : 0;
      return toQuote(rawModel, rawCompute);
    }
    default: {
      // Exhaustiveness is the contract check: a surface added to `BeforeUsageParams`
      // fails `tsc` here rather than quoting zero for it.
      const unquoted: never = params;
      throw new Error(`unquoted usage context: ${JSON.stringify(unquoted)}`);
    }
  }
}

/** Assemble the two raw components into the quote admission gates on. */
function toQuote(rawModel: number, rawCompute: number): UsageQuote {
  const modelCredits = toCredits(rawModel);
  const computeCredits = toCredits(rawCompute);
  return { modelCredits, computeCredits, totalCredits: modelCredits + computeCredits };
}
