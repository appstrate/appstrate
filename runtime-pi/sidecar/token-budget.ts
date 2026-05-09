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
 *   1. **Per-call token estimate** — `estimateTokens()` converts a
 *      response body to an estimated token count via the
 *      Anthropic-recommended heuristic of ~3.5 chars/token. The
 *      sidecar chooses inline vs. spill on tokens, not bytes.
 *
 *   2. **Cumulative budget per run** — `TokenBudget` tracks how many
 *      tool-output tokens the agent has consumed over the run's
 *      lifetime. As the budget approaches exhaustion, the inline
 *      threshold tightens (we spill more aggressively). Beyond the
 *      ceiling, every text response spills to the blob store with a
 *      structured truncation marker.
 *
 * Why a heuristic and not the real Anthropic / OpenAI tokenizer?
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
 *   - The heuristic is deterministic, allocation-free, and so cheap
 *     it is dominated by the upstream HTTP hop the tool already
 *     performs.
 *
 * Operators who need exact counts can run a tokenizer-backed proxy
 * upstream of the sidecar. The shape of the contract here is the same.
 *
 * Out of scope (issue #390 deliberately leaves these to follow-ups):
 *   - Auto-compaction of conversational history (lives above the SDK).
 *   - Per-tool / per-provider caps (one knob is enough at this stage).
 *   - LLM-backed summarisation of spilled blobs (separate feature).
 */

/**
 * Anthropic-recommended chars-per-token ratio for offline estimation.
 * Documented in the Claude API token-counting guide as
 * "1 token ≈ 3.5 English characters". Conservative for JSON / code
 * (which trends slightly higher tokens-per-char), generous for prose.
 *
 * We treat one byte of a non-text payload (binary spill candidate) as
 * one token equivalent so callers don't have to special-case binary —
 * the calling code already routes binary responses through the blob
 * store before consulting the budget.
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
 * Default cumulative budget per run. 200 K tokens — the full default
 * Claude / Opus context window. The platform reserves additional space
 * for the system prompt, agent instructions, and conversation
 * history; this budget covers tool outputs only.
 *
 * Operators on 1 M-token Sonnet 4.6 deployments will likely raise this
 * via `SIDECAR_RUN_TOOL_OUTPUT_BUDGET_TOKENS`; OSS / dev defaults
 * stay conservative.
 */
export const DEFAULT_RUN_OUTPUT_BUDGET_TOKENS = 200_000;

/**
 * Estimate the token count of a string using the Anthropic-recommended
 * heuristic. Returns a non-negative integer. Empty input returns 0.
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
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate the token cost of a binary payload (base64 inflation
 * factor applied if/when the agent reads it). Used for symmetry with
 * `estimateTokens` so callers don't branch on text vs. binary —
 * binary always spills, but the budget bookkeeper still wants a number.
 *
 * Conservative: assumes the agent will eventually base64-read the
 * blob (1.37× inflation) and tokenise the resulting string at the
 * heuristic ratio.
 */
export function estimateBinaryTokens(byteLength: number): number {
  if (byteLength <= 0) return 0;
  // Base64 inflates by 4/3, then chars-per-token.
  return Math.ceil((byteLength * 4) / 3 / CHARS_PER_TOKEN);
}

/**
 * Decision returned by `TokenBudget.decide()`. The caller (today:
 * `responseToToolResult` in `mcp.ts`) acts on `decision`; `reason` is
 * surfaced to the agent as structured `_meta` so it can react.
 */
export interface BudgetDecision {
  /**
   * - `inline`  — agent receives the full content as a `text` block.
   * - `spill`   — agent receives a `resource_link`; bytes are stashed
   *               in the blob store. May be triggered by per-call
   *               size, by cumulative budget pressure, or by absence
   *               of a viable inline path.
   */
  decision: "inline" | "spill";
  /**
   * Discriminated reason for the decision. Always set, including on
   * `inline` — observability and tests both depend on the reason
   * being explicit rather than implied by `decision === "inline"`.
   */
  reason:
    | "under_inline_cap"
    | "exceeds_inline_cap"
    | "exceeds_run_budget"
    | "no_blob_store_fallback_inline";
  /** Estimated tokens for *this* response. */
  estimatedTokens: number;
  /** Cumulative tokens consumed by tool outputs so far in this run. */
  consumedTokens: number;
  /** Configured ceiling for the run. */
  runBudgetTokens: number;
  /** Configured per-call inline cap. */
  inlineCapTokens: number;
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
}

/**
 * Read a positive-integer token cap from an env var, falling back to
 * `defaultValue` when unset/empty. Mirrors `readPositiveByteEnv` in
 * `helpers.ts` so misconfiguration fails loud at boot.
 */
export function readPositiveTokenEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (tokens), got ${JSON.stringify(raw)}.`);
  }
  return parsed;
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
 */
export class TokenBudget {
  readonly inlineCapTokens: number;
  readonly runBudgetTokens: number;
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
    this.inlineCapTokens = inlineCap;
    this.runBudgetTokens = runBudget;
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
   * Decide whether a response of `estimatedTokens` should be inlined.
   *
   * The caller still has the option of forcing `spill` (e.g. when no
   * blob store is configured we have no spill path). This method only
   * answers the budget question — see {@link decideForResponse} for
   * the full integration helper.
   */
  decide(estimatedTokens: number): BudgetDecision {
    if (estimatedTokens > this.inlineCapTokens) {
      return {
        decision: "spill",
        reason: "exceeds_inline_cap",
        estimatedTokens,
        consumedTokens: this.consumed,
        runBudgetTokens: this.runBudgetTokens,
        inlineCapTokens: this.inlineCapTokens,
      };
    }
    if (this.consumed + estimatedTokens > this.runBudgetTokens) {
      return {
        decision: "spill",
        reason: "exceeds_run_budget",
        estimatedTokens,
        consumedTokens: this.consumed,
        runBudgetTokens: this.runBudgetTokens,
        inlineCapTokens: this.inlineCapTokens,
      };
    }
    return {
      decision: "inline",
      reason: "under_inline_cap",
      estimatedTokens,
      consumedTokens: this.consumed,
      runBudgetTokens: this.runBudgetTokens,
      inlineCapTokens: this.inlineCapTokens,
    };
  }

  /**
   * Record `tokens` against the budget. Saturates at the ceiling so
   * the tracker never reports a negative remaining figure even if a
   * caller records more than `decide()` recommended (the caller
   * always gets the chance to abort first; record-after-deliver is
   * the contract).
   */
  record(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.consumed = Math.min(this.runBudgetTokens, this.consumed + Math.ceil(tokens));
  }

  /** Test-only: reset the tracker. */
  reset(): void {
    this.consumed = 0;
  }
}
