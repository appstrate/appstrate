// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Token-aware context budgeting for `provider_call` tool outputs.
 *
 * Background — see issue #390. The byte-based caps in `helpers.ts`
 * (`MAX_RESPONSE_SIZE`, `ABSOLUTE_MAX_RESPONSE_SIZE`) protect against
 * OOM and "agent downloads a 10 MB PDF" scenarios but do not reflect
 * the true cost of a tool output in the agent's context window:
 *
 *   - 256 KB of dense JSON ≈ 65-90 K tokens (ratio 3-4×).
 *   - 256 KB of natural-language prose ≈ 60-80 K tokens.
 *   - 256 KB of base64-encoded binary ≈ 80 K tokens.
 *
 * A 256 KB JSON response that fits under the byte cap can therefore
 * burn through a 200 K-token context window in a single call. Worse,
 * 50 successive `provider_call`s each at ~30 KB JSON (well under the
 * 32 KB inline threshold) accumulate ~400 K tokens of context with no
 * guard-rail — every call is judged in isolation.
 *
 * This module adds two layers on top of the existing byte caps:
 *
 *   1. **Per-call token estimate** — the configured estimator converts
 *      a response body to an estimated token count. The default uses
 *      the Anthropic-recommended ~3.5 chars/token heuristic; operators
 *      can inject a real tokenizer via {@link TokenBudgetOptions.estimate}.
 *      The sidecar chooses inline vs. spill on tokens, not bytes.
 *
 *   2. **Cumulative budget per run** — `TokenBudget` tracks how many
 *      tool-output tokens the agent has consumed over the run's
 *      lifetime. As the budget approaches exhaustion, the inline
 *      threshold tightens (we spill more aggressively). Beyond the
 *      ceiling, every text response spills to the blob store with a
 *      structured truncation marker.
 *
 * Why a heuristic by default?
 *
 *   - The sidecar runs in-container, on the hot path of every
 *     `provider_call`. A real tokenizer (`@anthropic-ai/tokenizer`
 *     for legacy Claude, `js-tiktoken` with `p50k_base` as a Claude
 *     proxy, or the Anthropic `count_tokens` API) costs anywhere from
 *     5-50 ms per call — adding 50-500 ms of overhead to typical
 *     LLM-driven tool sequences.
 *
 *   - The official `@anthropic-ai/tokenizer` package is itself
 *     deprecated for Claude 3+ models — Anthropic explicitly
 *     recommends the 3.5 chars/token heuristic for offline
 *     estimation in their token-counting docs.
 *
 *   - The decision we are making is "spill or inline?" — a rough
 *     order-of-magnitude estimate is sufficient. Exact counts are
 *     the LLM provider's responsibility (and modern Sonnet/Opus
 *     models surface remaining context themselves).
 *
 *   - Operators who *do* need exact counts can pass a custom
 *     `estimate` callback at construction time. The shape of the
 *     contract is the same; only the cost of the estimate changes.
 *
 * Out of scope (issue #390 deliberately leaves these to follow-ups):
 *   - Auto-compaction of conversational history (lives above the SDK).
 *   - Per-tool / per-provider caps (one knob is enough at this stage).
 *   - LLM-backed summarisation of spilled blobs (separate feature).
 */

import { readPositiveIntEnv } from "./helpers.ts";

/**
 * Anthropic-recommended chars-per-token ratio for offline estimation.
 * Documented in the Claude API token-counting guide as
 * "1 token ≈ 3.5 English characters". Conservative for JSON / code
 * (which trends slightly higher tokens-per-char), generous for prose.
 */
const CHARS_PER_TOKEN = 3.5;

/**
 * Default per-call inline budget. ~8000 tokens ≈ 28 KB of English text
 * — the existing 32 KB byte threshold expressed in tokens. Anything
 * above this spills to the blob store regardless of the cumulative
 * budget state. Override via `SIDECAR_INLINE_TOOL_OUTPUT_TOKENS`.
 */
export const DEFAULT_INLINE_OUTPUT_TOKENS = 8_000;

/**
 * Default cumulative budget per run. 100 K tokens — half the default
 * Claude / Opus context window. The platform reserves additional space
 * for the system prompt, agent instructions, and conversation
 * history; this budget covers tool outputs only.
 *
 * Tightened from 200 K after issue #427: an agent fanning out 8
 * parallel `provider_call`s could pack ~525 KB of JSON (~150 K tokens)
 * of tool output into a single LLM turn and blow past the upstream
 * model's TPM window before any retry / Retry-After negotiation
 * could land. Keeping the ceiling well below typical model context
 * windows leaves headroom for system prompt + conversation history
 * while preserving the spill-to-blob escape hatch for anything
 * heavier.
 *
 * Operators on 1 M-token Sonnet 4.6 deployments (or anyone whose
 * upstream model TPM accommodates more) raise this via
 * `SIDECAR_RUN_TOOL_OUTPUT_BUDGET_TOKENS`; OSS / dev defaults stay
 * conservative.
 */
export const DEFAULT_RUN_OUTPUT_BUDGET_TOKENS = 100_000;

/**
 * Pluggable token estimator. Receives a text payload, returns a
 * non-negative integer count. Implementations should be deterministic
 * for a given input. The default is the Anthropic-recommended
 * heuristic ({@link estimateTokens}); operators can inject a real
 * tokenizer (tiktoken, `count_tokens` API, …) at the cost of a
 * per-call hop.
 */
export type TokenEstimator = (text: string) => number;

/**
 * Default estimator using the Anthropic-recommended chars/token ratio.
 * Returns a non-negative integer. Empty input returns 0.
 *
 * Uses `Math.ceil` so any non-empty string costs at least one token —
 * matches real tokenizer behaviour (the smallest encoded sequence is a
 * single piece) and avoids a pathological "free" path for short inputs.
 *
 * The implementation is intentionally O(1) — JavaScript's `.length` on
 * a string is the UTF-16 code-unit count, computed from the string
 * header, not by iterating. This keeps the sidecar's hot path
 * allocation-free.
 */
export const estimateTokens: TokenEstimator = (text) => {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
};

/**
 * Decision returned by {@link TokenBudget.decide} and
 * {@link TokenBudget.tryReserve}.
 *
 * The reason union is intentionally narrow: only the three states the
 * tracker itself can produce. Fallback states triggered by the caller
 * (no blob store configured, blob store full, …) are surfaced through
 * a wider union in the agent-facing `_meta` payload — they are not
 * decisions the budget can make.
 */
export interface BudgetDecision {
  /**
   * - `inline`  — agent receives the full content as a `text` block.
   * - `spill`   — agent receives a `resource_link`; bytes are stashed
   *               in the blob store. Triggered by per-call size,
   *               cumulative run-budget pressure, or upstream
   *               context-window pressure (when wired).
   */
  decision: "inline" | "spill";
  /**
   * Discriminated reason for the decision. Always set, including on
   * `inline` — observability and tests both depend on the reason
   * being explicit rather than implied by `decision === "inline"`.
   *
   * - `exceeds_context_window` is emitted only when the budget is
   *   wired with {@link TokenBudgetOptions.contextWindowTokens}: a
   *   call that would push `consumed + estimated` past
   *   `contextWindow - reserveTokens` spills even if it would fit
   *   under the inline cap and the run-level ceiling. Added in #464
   *   to handle parallel tool-call fan-outs that individually fit
   *   but collectively blow past the upstream model's hard limit
   *   before Pi SDK's turn-boundary compaction fires.
   */
  reason:
    | "under_inline_cap"
    | "exceeds_inline_cap"
    | "exceeds_run_budget"
    | "exceeds_context_window";
  /** Estimated tokens for *this* response. */
  estimatedTokens: number;
  /** Cumulative tokens consumed by tool outputs so far in this run. */
  consumedTokens: number;
  /** Configured ceiling for the run. */
  runBudgetTokens: number;
  /** Configured per-call inline cap. */
  inlineCapTokens: number;
  /**
   * Configured upstream context-window cap (tokens), or null when the
   * budget is not wired with a model-level limit. Surfaced for
   * observability — agents can read this from the `_meta` payload to
   * surface "X / Y context tokens" in their own UI.
   */
  contextWindowTokens: number | null;
  /** Configured reserve (response budget) within the context window. */
  reserveTokens: number;
}

export interface TokenBudgetOptions {
  /**
   * Per-call cap. Anything strictly above this spills, regardless of
   * how much budget is left.
   */
  inlineCapTokens?: number;
  /**
   * Cumulative ceiling per run. When `consumedTokens + estimated >
   * runBudgetTokens`, the response spills (and is truncated /
   * summarised by the spill path) — even if it would otherwise fit
   * inline.
   */
  runBudgetTokens?: number;
  /**
   * Upstream model's total context window (tokens). When set, adds a
   * pre-flight guard: a response that would push
   * `consumed + estimated` past `contextWindowTokens - reserveTokens`
   * spills regardless of the run-budget ceiling. Defends against the
   * "10 parallel tool_results, each fits inline, sum blows the model's
   * hard limit" failure mode (#464). When unset, the legacy two-tier
   * (inline cap + run budget) guard remains the only check.
   */
  contextWindowTokens?: number;
  /**
   * Reserve (tokens) the upstream model keeps for its response. Only
   * meaningful in combination with {@link contextWindowTokens}.
   * Defaults to `max(16384, floor(contextWindowTokens × 0.2))` — the
   * same heuristic the runner uses for Pi SDK compaction sizing, kept
   * in sync deliberately so a missing `maxTokens` cascades to the same
   * conservative fallback in both places.
   */
  reserveTokens?: number;
  /**
   * Optional override of the token-counting function. Defaults to
   * {@link estimateTokens} (the chars/3.5 heuristic). Operators who
   * need exact counts can inject a real tokenizer here at the cost
   * of a per-call hop.
   */
  estimate?: TokenEstimator;
}

/**
 * Floor on the derived `reserveTokens` when only `contextWindowTokens`
 * is supplied. Matches `DEFAULT_RESERVE_TOKENS` in
 * `packages/runner-pi/src/pi-runner.ts` — deliberate so the
 * platform-side compaction threshold and the sidecar-side spill guard
 * land on the same numbers for the same model. Bump both together.
 */
const MIN_DERIVED_RESERVE_TOKENS = 16_384;

/**
 * Fraction of the context window to reserve for the model's response
 * when no explicit `reserveTokens` (or `maxTokens` on the upstream
 * model) is supplied. 20 % covers Sonnet thinking @ 64 k on a 200 k
 * window without overshooting; smaller windows scale down naturally.
 */
const DEFAULT_RESERVE_FRACTION = 0.2;

function deriveReserveTokens(contextWindowTokens: number, explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  return Math.max(
    MIN_DERIVED_RESERVE_TOKENS,
    Math.floor(contextWindowTokens * DEFAULT_RESERVE_FRACTION),
  );
}

/**
 * Read a positive-integer token cap from an env var, falling back to
 * `defaultValue` when unset/empty. Delegates to {@link readPositiveIntEnv}
 * from `helpers.ts` with `unit: "tokens"` so misconfiguration fails loud
 * at boot.
 */
export function readPositiveTokenEnv(name: string, defaultValue: number): number {
  return readPositiveIntEnv(name, defaultValue, { unit: "tokens" });
}

/**
 * Run-scoped cumulative token budget tracker.
 *
 * One instance per sidecar process (each sidecar serves exactly one
 * run). The tracker is consulted by `responseToToolResult` for every
 * provider tool output, and only output paths that actually deliver
 * content to the agent (`inline`) are recorded. Spilled content is
 * not recorded — the agent reads bytes from the blob store on demand,
 * and at read time the bytes are tokenised by the LLM's actual
 * tokenizer, not by our heuristic. Double-counting would penalise
 * the agent for content it never read.
 *
 * **Concurrency model.** The sidecar runs on Bun's single-threaded
 * event loop, so no two `decide()` calls execute simultaneously.
 * However, `responseToToolResult` is async: between `decide()` and
 * `record()`, the event loop may interleave another tool call. Two
 * parallel calls could therefore both observe the pre-record
 * `consumed` snapshot and both decide `inline`, then both record —
 * briefly over-spending the inline budget by one call's worth.
 *
 * Use {@link tryReserve} for the inline path: it folds decide + record
 * into a single synchronous step, eliminating the interleave window.
 * The two-phase {@link decide} + {@link record} API is preserved for
 * paths that deliver content the budget didn't authorize (e.g.
 * blob-store-full fallback) and need to record after the fact.
 */
export class TokenBudget {
  readonly inlineCapTokens: number;
  readonly runBudgetTokens: number;
  readonly contextWindowTokens: number | null;
  readonly reserveTokens: number;
  private readonly estimator: TokenEstimator;
  private consumed = 0;

  constructor(options: TokenBudgetOptions = {}) {
    const inlineCap = options.inlineCapTokens ?? DEFAULT_INLINE_OUTPUT_TOKENS;
    const runBudget = options.runBudgetTokens ?? DEFAULT_RUN_OUTPUT_BUDGET_TOKENS;
    if (!Number.isFinite(inlineCap) || !Number.isInteger(inlineCap) || inlineCap <= 0) {
      throw new Error(`TokenBudget: inlineCapTokens must be a positive integer, got ${inlineCap}`);
    }
    if (!Number.isFinite(runBudget) || !Number.isInteger(runBudget) || runBudget <= 0) {
      throw new Error(`TokenBudget: runBudgetTokens must be a positive integer, got ${runBudget}`);
    }
    if (inlineCap > runBudget) {
      throw new Error(
        `TokenBudget: inlineCapTokens (${inlineCap}) cannot exceed runBudgetTokens (${runBudget}).`,
      );
    }
    const ctx = options.contextWindowTokens;
    if (ctx !== undefined) {
      if (!Number.isFinite(ctx) || !Number.isInteger(ctx) || ctx <= 0) {
        throw new Error(
          `TokenBudget: contextWindowTokens must be a positive integer when set, got ${ctx}`,
        );
      }
      const reserve = deriveReserveTokens(ctx, options.reserveTokens);
      if (!Number.isFinite(reserve) || !Number.isInteger(reserve) || reserve <= 0) {
        throw new Error(`TokenBudget: reserveTokens must be a positive integer, got ${reserve}`);
      }
      if (reserve >= ctx) {
        throw new Error(
          `TokenBudget: reserveTokens (${reserve}) must be strictly less than contextWindowTokens (${ctx}).`,
        );
      }
      this.contextWindowTokens = ctx;
      this.reserveTokens = reserve;
    } else if (options.reserveTokens !== undefined) {
      // `reserveTokens` is only meaningful alongside `contextWindowTokens` —
      // surfacing the mismatch loudly beats silently dropping the value.
      throw new Error(
        "TokenBudget: reserveTokens supplied without contextWindowTokens — both must be set together.",
      );
    } else {
      this.contextWindowTokens = null;
      this.reserveTokens = 0;
    }
    this.inlineCapTokens = inlineCap;
    this.runBudgetTokens = runBudget;
    this.estimator = options.estimate ?? estimateTokens;
  }

  /** Tokens consumed so far by inline tool outputs in this run. */
  consumedTokens(): number {
    return this.consumed;
  }

  /** Tokens still available before the run-level ceiling kicks in. */
  remainingTokens(): number {
    return Math.max(0, this.runBudgetTokens - this.consumed);
  }

  /**
   * Estimate the token cost of a text payload using the configured
   * estimator (defaults to the {@link estimateTokens} heuristic).
   * Exposed so callers don't need to know which estimator was wired
   * at construction time.
   */
  estimate(text: string): number {
    return this.estimator(text);
  }

  /**
   * Pure decision function — answers "would `estimatedTokens` fit?"
   * without mutating budget state. Use this when the caller may
   * deliver content the budget didn't authorize (blob-store-full
   * fallback) and needs to {@link record} after the fact.
   *
   * For the common inline path, prefer {@link tryReserve} which folds
   * decide + record into a single synchronous step.
   */
  decide(estimatedTokens: number): BudgetDecision {
    if (estimatedTokens > this.inlineCapTokens) {
      return this.snapshot("spill", "exceeds_inline_cap", estimatedTokens);
    }
    // Context-window guard runs BEFORE the run-budget check: the
    // upstream model's hard limit is the load-bearing constraint —
    // exceeding the run budget is a soft signal we'd rather tighten,
    // exceeding the context window is a guaranteed 400 from the LLM
    // provider on the next call.
    if (
      this.contextWindowTokens !== null &&
      this.consumed + estimatedTokens > this.contextWindowTokens - this.reserveTokens
    ) {
      return this.snapshot("spill", "exceeds_context_window", estimatedTokens);
    }
    if (this.consumed + estimatedTokens > this.runBudgetTokens) {
      return this.snapshot("spill", "exceeds_run_budget", estimatedTokens);
    }
    return this.snapshot("inline", "under_inline_cap", estimatedTokens);
  }

  /**
   * Atomic decide-and-reserve. If the decision is `inline`, records
   * the tokens against the budget *before returning*, eliminating the
   * decide/record interleave window described in the class JSDoc.
   * On `spill`, the budget is left unchanged.
   *
   * The returned snapshot reflects the *post-record* consumed count,
   * so callers building observability `_meta` see the same total the
   * next caller will see.
   */
  tryReserve(estimatedTokens: number): BudgetDecision {
    const decision = this.decide(estimatedTokens);
    if (decision.decision === "inline") {
      this.commit(estimatedTokens);
      return this.snapshot(decision.decision, decision.reason, estimatedTokens);
    }
    return decision;
  }

  /**
   * Record tokens delivered outside the {@link tryReserve} path
   * (e.g. blob-store-full fallback where we deliver inline despite a
   * spill decision). Saturates at the ceiling.
   *
   * In non-production environments invalid input throws — internal
   * callers should never pass a bad number, and a silent no-op masks
   * real bugs. Production stays defensive (silent no-op) so a runtime
   * misuse cannot crash an active run.
   */
  record(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) {
      if (process.env.NODE_ENV !== "production") {
        throw new Error(
          `TokenBudget.record: expected a positive finite number, got ${String(tokens)}`,
        );
      }
      return;
    }
    this.commit(tokens);
  }

  /** Internal: actually mutate the consumed counter (saturating). */
  private commit(tokens: number): void {
    this.consumed = Math.min(this.runBudgetTokens, this.consumed + Math.ceil(tokens));
  }

  /** Internal: build a {@link BudgetDecision} from current state. */
  private snapshot(
    decision: BudgetDecision["decision"],
    reason: BudgetDecision["reason"],
    estimatedTokens: number,
  ): BudgetDecision {
    return {
      decision,
      reason,
      estimatedTokens,
      consumedTokens: this.consumed,
      runBudgetTokens: this.runBudgetTokens,
      inlineCapTokens: this.inlineCapTokens,
      contextWindowTokens: this.contextWindowTokens,
      reserveTokens: this.reserveTokens,
    };
  }
}
