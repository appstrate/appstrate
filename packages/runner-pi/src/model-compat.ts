// SPDX-License-Identifier: Apache-2.0

/**
 * The `compat` flags every model record the PLATFORM prices must carry.
 *
 * This exists as one constant because the reason below is one reason, and it
 * was previously spelled out three times, in three packages, as three
 * hand-written `supportsLongCacheRetention: false` literals with three long
 * comments — while two of the five model builders carried neither. A rule that
 * has to be remembered at each new construction site is a convention; a
 * constant that every site spreads is a rule.
 *
 * ## Why long cache retention is refused
 *
 * The platform cannot price what it would produce. Anthropic bills a 1h cache
 * write at 2x the input rate, and a `ModelCost` record (`@appstrate/core`,
 * `computeTokenCost` in `@appstrate/afps-runtime/runner`) carries ONE
 * `cacheWrite` rate, not two. A long-retention write is therefore metered at
 * the short-retention price and the org is under-billed.
 *
 * pi-ai gates every long-retention emission on this single flag —
 * `cache_control.ttl: "1h"` for anthropic-messages, `prompt_cache_retention`
 * for both OpenAI shapes — and reads it as `model.compat?.… ?? true`. Silence
 * is consent: the record has to refuse OUT LOUD. It then resolves each
 * request's retention from `options.cacheRetention` and, failing that,
 * `process.env.PI_CACHE_RETENTION`. Both are reachable by someone the platform
 * does not control — agent code assigns to `process.env` from inside its own
 * container, and the CLI runs on the user's own machine — so refusing the
 * option at the boundary is necessary and NOT sufficient. This flag is the
 * sufficient half, and it holds for any value anyone picks.
 *
 * Turning it back on is a pricing change, not a performance tweak: it needs a
 * second cache-write rate in the catalog and in `computeTokenCost` first.
 *
 * Spread it rather than assigning it, so a site that needs an additional
 * per-record flag (the sidecar's `forceAdaptiveThinking`) can add one without
 * dropping these:
 *
 * ```ts
 * compat: { ...PLATFORM_MODEL_COMPAT, ...(adaptive ? { forceAdaptiveThinking: true } : {}) }
 * ```
 *
 * Coverage is pinned by `apps/api/test/unit/model-compat-coverage.test.ts`,
 * which enumerates the model builders and fails on a new one that omits this.
 */
export const PLATFORM_MODEL_COMPAT = {
  supportsLongCacheRetention: false,
} as const;

/**
 * The all-zero `ModelCost` record — the ONE spelling of
 * `{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`.
 *
 * It was hand-written at six construction sites, and the reason it is there is
 * NOT the same at all six. One indistinguishable literal, two meanings:
 *
 *  1. **Load-bearing opacity.** The sidecar rebuilds the REAL backing's pi-ai
 *     `Model` to re-originate an aliased run's inference against it
 *     (`runtime-pi/sidecar/pi-messages-backend.ts`, `buildBackingModel`).
 *     pi-ai writes `usage.cost` from `model.cost` on every settled turn, and
 *     that number rides the terminal `done` event back into the container —
 *     where a real rate card is one catalog lookup from naming the vendor the
 *     alias exists to hide. Zeros here are a DISCLOSURE control: substituting
 *     the backing's true card would leak the backing. The platform prices the
 *     ledger row server-side and never reads this value.
 *
 *  2. **Required-shape filler.** The Pi SDK types `Model.cost` as required, so
 *     an UNPRICED model still has to carry the shape
 *     (`runtime-pi/env.ts`, `packages/module-chat/src/pi-chat/model-binding.ts`).
 *     Nothing bills off these zeros either: the runner's `unpriced` flag and
 *     the row's `pricing_status='unpriced'` are what stop a 0 escaping as a
 *     real price.
 *
 * What both meanings share is the invariant that matters: **a zero here is
 * never a price**. Any site that wants zeros because the model really is free
 * must say so with a real `ModelCost`, not by spreading this.
 *
 * Lives beside {@link PLATFORM_MODEL_COMPAT} for the same reason that constant
 * does — every model-record construction site in the tree already imports this
 * module, and a rule that has to be remembered at each new site is a
 * convention, not a rule.
 *
 * Spread it rather than assigning it, so the `Usage.cost` shape (which adds a
 * `total` roll-up) can extend it without re-forking the four rates:
 *
 * ```ts
 * cost: { ...ZERO_MODEL_COST, total: 0 }
 * ```
 */
export const ZERO_MODEL_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;
